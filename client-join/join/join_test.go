package join

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"strings"
	"testing"
)

type fakeRunner struct {
	commands [][]string
	stdin    []string
	fail     map[string]string
}

func newRunner() *fakeRunner { return &fakeRunner{fail: map[string]string{}} }

func (f *fakeRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	return f.RunWithInput(ctx, "", name, args...)
}

func (f *fakeRunner) RunWithInput(
	_ context.Context, stdin string, name string, args ...string,
) (string, error) {
	f.commands = append(f.commands, append([]string{name}, args...))
	f.stdin = append(f.stdin, stdin)
	if message, bad := f.fail[name]; bad {
		return "", &runError{message}
	}
	return "", nil
}

func (f *fakeRunner) ran(name, contains string) bool {
	for _, command := range f.commands {
		if command[0] == name && strings.Contains(strings.Join(command, " "), contains) {
			return true
		}
	}
	return false
}

type runError struct{ message string }

func (e *runError) Error() string { return e.message }

func testEnv(t *testing.T) (Env, *fakeRunner) {
	t.Helper()
	runner := newRunner()
	return Env{Root: t.TempDir(), Run: runner}, runner
}

func read(t *testing.T, env Env, path string) string {
	t.Helper()
	body, err := os.ReadFile(env.Path(path))
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(body)
}

func options() Options {
	return Options{
		Domain:    "corp.example.internal",
		Hostname:  "ws01.corp.example.internal",
		AdminUser: "Administrator",
		Password:  "secret",
	}
}

// -------------------------------------------------------------- validation --

func TestValidateDerivesRealmAndQualifiesTheHostName(t *testing.T) {
	o := Options{Domain: "Corp.Example.Internal.", Hostname: "ws01", AdminUser: "Administrator"}
	if err := o.Validate(); err != nil {
		t.Fatal(err)
	}
	if o.Domain != "corp.example.internal" {
		t.Errorf("domain = %q", o.Domain)
	}
	if o.Realm != "CORP.EXAMPLE.INTERNAL" {
		t.Errorf("realm = %q", o.Realm)
	}
	if o.Hostname != "ws01.corp.example.internal" {
		t.Errorf("hostname = %q", o.Hostname)
	}
	if !strings.HasPrefix(o.APIURL, "https://") {
		t.Errorf("api url = %q", o.APIURL)
	}
}

func TestValidateRequiresACredentialOrAToken(t *testing.T) {
	o := Options{Domain: "corp.example.internal", Hostname: "ws01.corp.example.internal"}
	if err := o.Validate(); err == nil {
		t.Fatal("a join with neither credential nor token must be refused")
	}
	o.OTP = "token"
	if err := o.Validate(); err != nil {
		t.Fatalf("a token alone should be enough: %v", err)
	}
}

func TestValidateRefusesHostileInput(t *testing.T) {
	for _, o := range []Options{
		{Domain: "", AdminUser: "a"},
		{Domain: "corp example", AdminUser: "a"},
		{Domain: "corp.example.internal", Hostname: "ws01;reboot", AdminUser: "a"},
		{Domain: "corp.example.internal", Server: "dc1 && rm -rf /", AdminUser: "a"},
	} {
		if err := o.Validate(); err == nil {
			t.Errorf("accepted %+v", o)
		}
	}
}

func TestValidateRefusesPlaintextControlPlane(t *testing.T) {
	o := options()
	o.APIURL = "http://odm.corp.example.internal"
	if err := o.Validate(); err == nil {
		t.Fatal("a plaintext control plane URL must be refused")
	}
}

// ------------------------------------------------------------- discovery --

func TestControllersAreOrderedByPriorityThenWeight(t *testing.T) {
	found := SelectControllers([]*net.SRV{
		{Target: "dc3.corp.example.internal.", Port: 389, Priority: 10, Weight: 50},
		{Target: "dc1.corp.example.internal.", Port: 389, Priority: 0, Weight: 100},
		{Target: "dc2.corp.example.internal.", Port: 389, Priority: 10, Weight: 100},
		{Target: "not a host name", Port: 389},
		nil,
	})

	names := make([]string, 0, len(found))
	for _, controller := range found {
		names = append(names, controller.Host)
	}
	if strings.Join(names, ",") != "dc1.corp.example.internal,dc2.corp.example.internal,dc3.corp.example.internal" {
		t.Fatalf("order = %v", names)
	}
}

// ------------------------------------------------------------ configuration --

func TestKrb5ConfNamesTheRealm(t *testing.T) {
	env, _ := testEnv(t)
	o := options()
	if err := o.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := WriteKrb5Conf(o, env); err != nil {
		t.Fatal(err)
	}

	body := read(t, env, Krb5ConfPath)
	for _, want := range []string{
		"default_realm = CORP.EXAMPLE.INTERNAL",
		"dns_lookup_kdc = true",
		".corp.example.internal = CORP.EXAMPLE.INTERNAL",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("krb5.conf missing %q:\n%s", want, body)
		}
	}
}

func TestSssdConfIsNotReadableByOthers(t *testing.T) {
	env, _ := testEnv(t)
	o := options()
	_ = o.Validate()
	if err := WriteSssdConf(o, env); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(env.Path(SssdConfPath))
	if err != nil {
		t.Fatal(err)
	}
	// sssd refuses to start if anyone else can read its configuration.
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
	body := read(t, env, SssdConfPath)
	if !strings.Contains(body, "ldap_sasl_authid = WS01$") {
		t.Errorf("machine identity wrong:\n%s", body)
	}
	if !strings.Contains(body, "id_provider = ad") {
		t.Errorf("identity provider wrong:\n%s", body)
	}
}

func TestNameServiceAddsSssExactlyOnce(t *testing.T) {
	env, _ := testEnv(t)
	if err := env.WriteFile(NsswitchPath, "passwd:         files\ngroup:          files\nhosts:          files dns\n", 0o644); err != nil {
		t.Fatal(err)
	}
	o := options()
	_ = o.Validate()

	for range 2 {
		if err := ConfigureNameService(context.Background(), o, env); err != nil {
			t.Fatal(err)
		}
	}

	body := read(t, env, NsswitchPath)
	if strings.Count(body, "sss") != 2 {
		t.Fatalf("sss added the wrong number of times:\n%s", body)
	}
	if !strings.Contains(body, "hosts:          files dns\n") {
		t.Errorf("an unrelated database was changed:\n%s", body)
	}
}

func TestKeytabIsWrittenPrivately(t *testing.T) {
	env, _ := testEnv(t)
	if err := WriteKeytab(env, []byte("keytab bytes")); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(env.Path(KeytabPath))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
}

func TestAnEmptyKeytabIsRefused(t *testing.T) {
	env, _ := testEnv(t)
	if err := WriteKeytab(env, nil); err == nil {
		t.Fatal("an empty keytab must not be installed")
	}
}

func TestAgentConfigPointsAtTheControlPlane(t *testing.T) {
	env, runner := testEnv(t)
	o := options()
	o.APIURL = "https://odm.corp.example.internal:8443"
	o.CACert = "/etc/odm/tls/api-ca.pem"
	_ = o.Validate()

	if err := InstallAgent(context.Background(), o, env); err != nil {
		t.Fatal(err)
	}

	var config AgentConfig
	if err := json.Unmarshal([]byte(read(t, env, AgentConfigPath)), &config); err != nil {
		t.Fatal(err)
	}
	if config.ServicePrincipal != "HTTP/odm.corp.example.internal" {
		t.Errorf("service principal = %q", config.ServicePrincipal)
	}
	if config.Keytab != KeytabPath || config.Realm != "CORP.EXAMPLE.INTERNAL" {
		t.Errorf("config = %+v", config)
	}
	if !runner.ran("systemctl", "enable --now odm-agent") {
		t.Error("the agent service was not enabled")
	}
}

// ------------------------------------------------------------------ joining --

func TestCredentialJoinNeverPutsThePasswordOnACommandLine(t *testing.T) {
	env, runner := testEnv(t)
	o := options()
	o.OU = "OU=Workstations,DC=corp,DC=example,DC=internal"
	_ = o.Validate()

	if err := NetAdsJoin(context.Background(), o, env); err != nil {
		t.Fatal(err)
	}

	for _, command := range runner.commands {
		if strings.Contains(strings.Join(command, " "), o.Password) {
			t.Fatalf("the password appeared in a command line: %v", command)
		}
	}
	if !runner.ran("net", "ads join -U Administrator") {
		t.Errorf("join not run: %v", runner.commands)
	}
	if !runner.ran("net", "createcomputer=OU=Workstations") {
		t.Errorf("the container was not passed: %v", runner.commands)
	}
	if !runner.ran("net", "ads keytab create") {
		t.Error("the machine keytab was not created")
	}
	if runner.stdin[0] != o.Password+"\n" {
		t.Error("the password was not fed on standard input")
	}
}

func TestAFailedJoinIsReportedNotIgnored(t *testing.T) {
	env, runner := testEnv(t)
	runner.fail["net"] = "Failed to join domain: Preauthentication failed"
	o := options()
	_ = o.Validate()

	if err := NetAdsJoin(context.Background(), o, env); err == nil {
		t.Fatal("a refused join must be an error")
	}
}

func TestDryRunChangesNothingOnTheHost(t *testing.T) {
	env, runner := testEnv(t)
	o := options()
	o.DryRun = true
	_ = o.Validate()

	if err := NetAdsJoin(context.Background(), o, env); err != nil {
		t.Fatal(err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("a dry run ran commands: %v", runner.commands)
	}
}

func TestBothFrontEndsProduceTheSameConfiguration(t *testing.T) {
	// The command and the desktop application both call Run with the same
	// options; this proves the sequence is deterministic given them.
	first, _ := testEnv(t)
	second, _ := testEnv(t)

	for _, env := range []Env{first, second} {
		o := options()
		o.Server = "dc1.corp.example.internal"
		o.DryRun = true
		if _, err := Run(context.Background(), o, env, nil); err != nil {
			t.Fatal(err)
		}
	}

	for _, path := range []string{Krb5ConfPath, SssdConfPath, AgentConfigPath, NsswitchPath} {
		if read(t, first, path) != read(t, second, path) {
			t.Fatalf("%s differs between runs", path)
		}
	}
}
