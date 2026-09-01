package apply

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

// fakeRunner records commands instead of running them, so the appliers can
// be tested without systemd, nft or sshd on the machine.
type fakeRunner struct {
	commands [][]string
	fail     map[string]string
	output   map[string]string
}

func newRunner() *fakeRunner {
	return &fakeRunner{fail: map[string]string{}, output: map[string]string{}}
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	f.commands = append(f.commands, append([]string{name}, args...))
	if message, bad := f.fail[name]; bad {
		return "", &runError{message}
	}
	if out, ok := f.output[name]; ok {
		return out, nil
	}
	return "", nil
}

func (f *fakeRunner) ran(name string, contains string) bool {
	for _, command := range f.commands {
		if command[0] != name {
			continue
		}
		if contains == "" || strings.Contains(strings.Join(command, " "), contains) {
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
	runner.output["systemd-escape"] = "mnt-shared\n"
	return Env{Root: t.TempDir(), Run: runner, State: NewState()}, runner
}

func read(t *testing.T, env Env, path string) string {
	t.Helper()
	body, err := os.ReadFile(env.Path(path))
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(body)
}

func statuses(results []policy.Result) map[string]string {
	out := map[string]string{}
	for _, result := range results {
		out[result.Setting] = result.Status
	}
	return out
}

// ------------------------------------------------------------------ basics --

func TestFilesAreWrittenWithTheRequestedMode(t *testing.T) {
	env, _ := testEnv(t)
	results := applyFiles(context.Background(), policy.Settings{
		Files: []policy.File{{Path: "/etc/motd", Content: "hello\n", Mode: "0600"}},
	}, env)

	if got := statuses(results)["files:/etc/motd"]; got != "success" {
		t.Fatalf("status = %q", got)
	}
	if body := read(t, env, "/etc/motd"); body != "hello\n" {
		t.Fatalf("content = %q", body)
	}
	info, err := os.Stat(env.Path("/etc/motd"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v (%v)", info.Mode().Perm(), err)
	}
}

func TestWriteFileIsAtomicAndLeavesNoTemporaries(t *testing.T) {
	env, _ := testEnv(t)
	if err := env.WriteFile("/etc/odm/x.conf", "one", 0o644, "", ""); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Dir(env.Path("/etc/odm/x.conf")))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".odm-") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}

func TestSystemdStatesMapToTheRightCommands(t *testing.T) {
	env, runner := testEnv(t)
	applySystemdUnits(context.Background(), policy.Settings{
		SystemdUnits: []policy.SystemdUnit{
			{Unit: "telnet.socket", State: "masked"},
			{Unit: "ssh.service", State: "enabled"},
		},
	}, env)

	if !runner.ran("systemctl", "mask --now telnet.socket") {
		t.Error("telnet.socket was not masked")
	}
	if !runner.ran("systemctl", "enable --now ssh.service") {
		t.Error("ssh.service was not enabled")
	}
}

func TestUnknownSystemdStateIsSkippedNotGuessed(t *testing.T) {
	env, _ := testEnv(t)
	results := applySystemdUnits(context.Background(), policy.Settings{
		SystemdUnits: []policy.SystemdUnit{{Unit: "ssh.service", State: "frobnicated"}},
	}, env)
	if statuses(results)["systemd:ssh.service"] != "skipped" {
		t.Fatalf("results = %+v", results)
	}
}

func TestCronFileNamesAvoidDotsWhichCronIgnores(t *testing.T) {
	env, _ := testEnv(t)
	applyCron(context.Background(), policy.Settings{
		Cron: []policy.CronJob{{Name: "nightly.trim", Schedule: "0 3 * * 0", Command: "/usr/sbin/fstrim -a"}},
	}, env)

	body := read(t, env, "/etc/cron.d/odm-nightly-trim")
	if !strings.Contains(body, "0 3 * * 0 root /usr/sbin/fstrim -a") {
		t.Fatalf("cron entry = %q", body)
	}
}

func TestFirewallBuildsAnIsolatedTable(t *testing.T) {
	env, runner := testEnv(t)
	applyFirewall(context.Background(), policy.Settings{
		Firewall: []policy.Firewall{
			{Name: "ssh", Action: "allow", Protocol: "tcp", Port: 22, Source: "10.0.0.0/8"},
			{Name: "block-smb", Action: "deny", Protocol: "tcp", Port: 445},
		},
	}, env)

	ruleset := read(t, env, firewallPath)
	// A dedicated table means ODM never disturbs rules another tool owns.
	if !strings.Contains(ruleset, "delete table inet odm") {
		t.Error("ruleset does not reset its own table")
	}
	if !strings.Contains(ruleset, "ip saddr 10.0.0.0/8 tcp dport 22 accept") {
		t.Errorf("allow rule missing from:\n%s", ruleset)
	}
	if !strings.Contains(ruleset, "tcp dport 445 drop") {
		t.Errorf("deny rule missing from:\n%s", ruleset)
	}
	if !runner.ran("nft", "-f") {
		t.Error("ruleset was never loaded")
	}
}

// ----------------------------------------------------------------- scripts --

func TestScriptsGetAnInterpreterAndAreExecutable(t *testing.T) {
	env, runner := testEnv(t)
	applyScripts(context.Background(), policy.Settings{
		Scripts: []policy.Script{{Trigger: "startup", Name: "inventory", Content: "id\n"}},
	}, env)

	body := read(t, env, "/etc/odm/scripts/startup/inventory")
	if !strings.HasPrefix(body, "#!/bin/sh\n") {
		t.Fatalf("missing shebang: %q", body)
	}
	info, _ := os.Stat(env.Path("/etc/odm/scripts/startup/inventory"))
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
	if !runner.ran("systemctl", "enable odm-scripts.service") {
		t.Error("startup unit was not enabled")
	}
}

func TestLogonScriptsInstallAPamHookExactlyOnce(t *testing.T) {
	env, _ := testEnv(t)
	if err := env.WriteFile(pamSessionPath, "session required pam_unix.so\n", 0o644, "", ""); err != nil {
		t.Fatal(err)
	}
	settings := policy.Settings{
		Scripts: []policy.Script{{Trigger: "logon", Name: "welcome", Content: "true\n"}},
	}
	applyScripts(context.Background(), settings, env)
	applyScripts(context.Background(), settings, env)

	body := read(t, env, pamSessionPath)
	if strings.Count(body, "pam_exec.so") != 1 {
		t.Fatalf("hook added %d times:\n%s", strings.Count(body, "pam_exec.so"), body)
	}
	if !strings.Contains(body, "session required pam_unix.so") {
		t.Fatalf("existing configuration was lost:\n%s", body)
	}
}

// ------------------------------------------------------------ managed block --

func TestReplaceBlockPreservesEverythingOutsideTheMarkers(t *testing.T) {
	env, _ := testEnv(t)
	original := "# top\nkeep me\n"
	if err := env.WriteFile("/etc/thing.conf", original, 0o644, "", ""); err != nil {
		t.Fatal(err)
	}
	if err := env.ReplaceBlock("/etc/thing.conf", "first\n", 0o644); err != nil {
		t.Fatal(err)
	}
	if err := env.ReplaceBlock("/etc/thing.conf", "second\n", 0o644); err != nil {
		t.Fatal(err)
	}

	body := read(t, env, "/etc/thing.conf")
	if !strings.Contains(body, "keep me") {
		t.Fatalf("outside content lost:\n%s", body)
	}
	if strings.Contains(body, "first") || !strings.Contains(body, "second") {
		t.Fatalf("block not replaced:\n%s", body)
	}
	if strings.Count(body, blockStart) != 1 {
		t.Fatalf("markers duplicated:\n%s", body)
	}
}

func TestEmptyBlockRemovesTheSection(t *testing.T) {
	env, _ := testEnv(t)
	_ = env.WriteFile("/etc/thing.conf", "keep\n", 0o644, "", "")
	_ = env.ReplaceBlock("/etc/thing.conf", "managed\n", 0o644)
	_ = env.ReplaceBlock("/etc/thing.conf", "", 0o644)

	body := read(t, env, "/etc/thing.conf")
	if strings.Contains(body, "managed") || strings.Contains(body, blockStart) {
		t.Fatalf("section not removed:\n%s", body)
	}
	if !strings.Contains(body, "keep") {
		t.Fatalf("outside content lost:\n%s", body)
	}
}

// -------------------------------------------------------------------- sudo --

func TestSudoRuleIsValidatedBeforeInstall(t *testing.T) {
	env, runner := testEnv(t)
	results := applySudo(context.Background(), policy.Settings{
		SudoRules: []policy.SudoRule{{
			Name: "helpdesk", Users: []string{"%Helpdesk"},
			Commands: []string{"/usr/bin/systemctl"}, NoPasswd: true,
		}},
	}, env)

	if !runner.ran("visudo", "-cf") {
		t.Fatal("sudoers file was installed without visudo validation")
	}
	if statuses(results)["sudo:helpdesk"] != "success" {
		t.Fatalf("results = %+v", results)
	}
	body := read(t, env, "/etc/sudoers.d/odm-helpdesk")
	if !strings.Contains(body, "%Helpdesk ALL=(ALL) NOPASSWD: /usr/bin/systemctl") {
		t.Fatalf("rule = %q", body)
	}

	// sudo parses everything in sudoers.d, so the validation candidate must
	// never be staged there.
	entries, err := os.ReadDir(env.Path(sudoersDir))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "odm-helpdesk" {
		names := []string{}
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("unexpected files in sudoers.d: %v", names)
	}
}

func TestInvalidSudoersIsNeverInstalled(t *testing.T) {
	env, runner := testEnv(t)
	runner.fail["visudo"] = "syntax error"

	results := applySudo(context.Background(), policy.Settings{
		SudoRules: []policy.SudoRule{{Name: "broken", Users: []string{"ada"}, Commands: []string{"ALL"}}},
	}, env)

	if statuses(results)["sudo:broken"] != "failed" {
		t.Fatalf("results = %+v", results)
	}
	if _, err := os.Stat(env.Path("/etc/sudoers.d/odm-broken")); !os.IsNotExist(err) {
		t.Fatal("invalid sudoers file was installed anyway")
	}
}

// -------------------------------------------------------------------- HBAC --

func TestDenyRulesArePlacedBeforeAllowRules(t *testing.T) {
	env, _ := testEnv(t)
	applyHbacRules(context.Background(), policy.Settings{
		HbacRules: []policy.HbacRule{
			{Principal: "%Engineers", Service: "all", Access: "allow"},
			{Principal: "%Contractors", Service: "all", Access: "deny"},
		},
	}, env)

	body := read(t, env, accessFileFor("ssh"))
	deny := strings.Index(body, "-:(Contractors)")
	allow := strings.Index(body, "+:(Engineers)")
	if deny == -1 || allow == -1 || deny > allow {
		t.Fatalf("pam_access takes the first match, so deny must come first:\n%s", body)
	}
}

func TestAnAllowListNeverLocksOutRoot(t *testing.T) {
	env, _ := testEnv(t)
	applyHbacRules(context.Background(), policy.Settings{
		HbacRules: []policy.HbacRule{
			{Principal: "%Engineers", Service: "all", Access: "allow"},
		},
	}, env)

	body := read(t, env, accessFileFor("local"))
	closing := strings.Index(body, "-:ALL:ALL")
	keepRoot := strings.Index(body, "+:root")
	if closing == -1 {
		t.Fatalf("allow list has no closing deny:\n%s", body)
	}
	if keepRoot == -1 || keepRoot > closing {
		t.Fatalf("root must stay allowed before the closing deny:\n%s", body)
	}
}

// A rule for one service must not gate another: "may use SSH" is not "may sit
// at the console".
func TestEachServiceIsGatedOnItsOwn(t *testing.T) {
	env, _ := testEnv(t)
	applyHbacRules(context.Background(), policy.Settings{
		HbacRules: []policy.HbacRule{
			{Principal: "%Engineers", Service: "ssh", Access: "allow"},
		},
	}, env)

	ssh := read(t, env, accessFileFor("ssh"))
	if !strings.Contains(ssh, "+:(Engineers)") || !strings.Contains(ssh, "-:ALL:ALL") {
		t.Errorf("the ssh rule did not close its own list:\n%s", ssh)
	}
	local := read(t, env, accessFileFor("local"))
	if strings.Contains(local, "-:ALL:ALL") {
		t.Errorf("an ssh rule closed the console's list too:\n%s", local)
	}
}

// sshd requires a user to match AllowUsers *and* AllowGroups when both are
// present, so an allow rule naming a group used to lock that group out: the
// group went in AllowGroups, root went in AllowUsers, and nobody satisfied
// both. Allowing is pam_access's job; sshd only refuses.
func TestSshdIsOnlyToldWhoToRefuse(t *testing.T) {
	env, _ := testEnv(t)
	applyHbacRules(context.Background(), policy.Settings{
		HbacRules: []policy.HbacRule{
			{Principal: "%Engineers", Service: "ssh", Access: "allow"},
			{Principal: "contractor1", Service: "ssh", Access: "deny"},
		},
	}, env)

	body := read(t, env, sshdDropIn)
	if strings.Contains(body, "AllowUsers") || strings.Contains(body, "AllowGroups") {
		t.Errorf("sshd was given an allow list, which it ANDs:\n%s", body)
	}
	if !strings.Contains(body, "DenyUsers contractor1") {
		t.Errorf("user deny wrong:\n%s", body)
	}
}

// ----------------------------------------------------------------- desktop --

func TestBrowserPolicyGoesToBothVendorLocations(t *testing.T) {
	env, _ := testEnv(t)
	applyBrowser(context.Background(), policy.Settings{
		Browser: &policy.Browser{
			Chromium: map[string]any{"HomepageLocation": "https://intranet.example.org"},
			Firefox:  map[string]any{"Homepage": map[string]any{"URL": "https://intranet.example.org"}},
		},
	}, env)

	for _, path := range chromiumPolicyPaths {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(read(t, env, path)), &parsed); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if parsed["HomepageLocation"] != "https://intranet.example.org" {
			t.Fatalf("%s: %v", path, parsed)
		}
	}

	var firefox map[string]any
	if err := json.Unmarshal([]byte(read(t, env, firefoxPolicyPath)), &firefox); err != nil {
		t.Fatal(err)
	}
	// Firefox requires its settings nested under "policies".
	if _, ok := firefox["policies"]; !ok {
		t.Fatalf("firefox policy not wrapped: %v", firefox)
	}
}

func TestWallpaperWritesADconfDatabaseAndLocksIt(t *testing.T) {
	env, runner := testEnv(t)
	applyWallpaper(context.Background(), policy.Settings{
		Wallpaper: &policy.Wallpaper{URI: "file:///usr/share/backgrounds/corp.png"},
	}, env)

	if profile := read(t, env, dconfProfilePath); !strings.Contains(profile, "system-db:odm") {
		t.Fatalf("profile = %q", profile)
	}
	if keys := read(t, env, dconfKeyfilePath); !strings.Contains(keys, "picture-options='zoom'") {
		t.Fatalf("keyfile = %q", keys)
	}
	if locks := read(t, env, dconfLockPath); !strings.Contains(locks, "picture-uri") {
		t.Fatalf("locks = %q", locks)
	}
	if !runner.ran("dconf", "update") {
		t.Error("dconf database was never rebuilt")
	}
}

// -------------------------------------------------------------- drive maps --

func TestMachineDriveMapUsesKerberosAndNeverStoresCredentials(t *testing.T) {
	env, runner := testEnv(t)
	applyDriveMaps(context.Background(), policy.Settings{
		DriveMaps: []policy.DriveMap{
			{Name: "shared", UNC: "//fs01/shared", MountPoint: "/mnt/shared"},
		},
	}, env)

	unit := read(t, env, "/etc/systemd/system/mnt-shared.mount")
	if !strings.Contains(unit, "sec=krb5") {
		t.Fatalf("mount is not Kerberos-authenticated:\n%s", unit)
	}
	for _, forbidden := range []string{"password", "credentials="} {
		if strings.Contains(unit, forbidden) {
			t.Fatalf("credential material in unit:\n%s", unit)
		}
	}
	// --now, or the drive map exists and does not run until a reboot.
	if !runner.ran("systemctl", "enable --now mnt-shared.automount") {
		t.Error("automount unit was not started")
	}
	if !strings.Contains(unit, "What=//fs01/shared") {
		t.Fatalf("a backslash is an escape character in a unit file:\n%s", unit)
	}
}

func TestPerUserDriveMapGoesThroughPamMount(t *testing.T) {
	env, _ := testEnv(t)
	results := applyDriveMaps(context.Background(), policy.Settings{
		DriveMaps: []policy.DriveMap{
			{Name: "home", UNC: "//fs01/home", MountPoint: "/mnt/home", ForPrincipal: "%Engineers"},
		},
	}, env)

	if statuses(results)["drive_maps:pam_mount"] != "success" {
		t.Fatalf("results = %+v", results)
	}
	body := read(t, env, pamMountPath)
	if !strings.Contains(body, `sgrp="Engineers"`) {
		t.Fatalf("group not targeted:\n%s", body)
	}
	if !strings.Contains(body, `server="fs01"`) || !strings.Contains(body, `path="home"`) {
		t.Fatalf("share not parsed:\n%s", body)
	}
}

// ------------------------------------------------------------------- prune --

func TestRemovingASettingRemovesItsFile(t *testing.T) {
	root := t.TempDir()
	runner := newRunner()
	runner.output["systemd-escape"] = "mnt-shared\n"

	first := Env{Root: root, Run: runner, State: NewState()}
	Apply(context.Background(), policy.Settings{
		Files: []policy.File{
			{Path: "/etc/motd", Content: "one"},
			{Path: "/etc/issue", Content: "two"},
		},
	}, first)

	second := Env{Root: root, Run: runner, State: NewState()}
	results := Apply(context.Background(), policy.Settings{
		Files: []policy.File{{Path: "/etc/motd", Content: "one"}},
	}, second)

	if _, err := os.Stat(filepath.Join(root, "etc/issue")); !os.IsNotExist(err) {
		t.Fatal("a file dropped from policy was left on the machine")
	}
	if _, err := os.Stat(filepath.Join(root, "etc/motd")); err != nil {
		t.Fatal("a file still in policy was removed")
	}
	if statuses(results)["removed:/etc/issue"] != "success" {
		t.Fatalf("removal not reported: %+v", results)
	}
}

func TestStateSurvivesARoundTrip(t *testing.T) {
	env, _ := testEnv(t)
	env.State.Own("/etc/motd")
	if err := SaveState(env); err != nil {
		t.Fatal(err)
	}
	if loaded := LoadState(env); !loaded.Owned["/etc/motd"] {
		t.Fatalf("state lost: %+v", loaded)
	}
}

func TestCorruptStateIsIgnoredRatherThanFatal(t *testing.T) {
	env, _ := testEnv(t)
	_ = os.MkdirAll(filepath.Dir(env.Path(StatePath)), 0o750)
	_ = os.WriteFile(env.Path(StatePath), []byte("{not json"), 0o600)

	if loaded := LoadState(env); loaded == nil || loaded.Owned == nil {
		t.Fatal("corrupt state should degrade to an empty state")
	}
}

// ------------------------------------------------------------- user scope --

func TestUserPolicyCannotReconfigureTheMachine(t *testing.T) {
	env, runner := testEnv(t)
	settings := policy.Settings{
		SystemdUnits: []policy.SystemdUnit{{Unit: "ssh.service", State: "stopped"}},
		SudoRules: []policy.SudoRule{
			{Name: "escalate", Users: []string{"mallory"}, Commands: []string{"ALL"}},
		},
		Firewall:  []policy.Firewall{{Name: "open", Action: "allow", Protocol: "tcp", Port: 1}},
		Wallpaper: &policy.Wallpaper{URI: "file:///usr/share/backgrounds/corp.png"},
	}

	results := ApplyUser(context.Background(), settings, env)

	if runner.ran("systemctl", "stop") {
		t.Error("a user policy stopped a system service")
	}
	if _, err := os.Stat(env.Path("/etc/sudoers.d/odm-escalate")); !os.IsNotExist(err) {
		t.Error("a user policy wrote a sudoers rule")
	}
	if _, err := os.Stat(env.Path(firewallPath)); !os.IsNotExist(err) {
		t.Error("a user policy rewrote the firewall")
	}
	if statuses(results)["wallpaper"] != "success" {
		t.Fatalf("user-scoped settings did not apply: %+v", results)
	}
}

func TestUserApplyNeverPrunesMachinePolicy(t *testing.T) {
	root := t.TempDir()
	runner := newRunner()
	runner.output["systemd-escape"] = "mnt-shared\n"

	machine := Env{Root: root, Run: runner, State: NewState()}
	Apply(context.Background(), policy.Settings{
		Files: []policy.File{{Path: "/etc/motd", Content: "managed"}},
	}, machine)

	user := Env{Root: root, Run: runner, State: NewState()}
	ApplyUser(context.Background(), policy.Settings{
		Wallpaper: &policy.Wallpaper{URI: "file:///corp.png"},
	}, user)

	if _, err := os.Stat(filepath.Join(root, "etc/motd")); err != nil {
		t.Fatal("a user login deleted machine policy")
	}
}

func TestSessionHookAppliesUserPolicyWithoutBlockingLogin(t *testing.T) {
	env, _ := testEnv(t)
	applyScripts(context.Background(), policy.Settings{}, env)

	hook := read(t, env, pamHookPath)
	if !strings.Contains(hook, `odm-agent apply --user "$PAM_USER"`) {
		t.Fatalf("hook does not apply user policy:\n%s", hook)
	}
	if !strings.Contains(hook, "timeout 60") {
		t.Fatalf("user apply is not bounded by a timeout:\n%s", hook)
	}
	if !strings.Contains(hook, ">/dev/null 2>&1 &") {
		t.Fatalf("user apply must be backgrounded so a slow API cannot block login:\n%s", hook)
	}
}

// ------------------------------------------------------------ trust anchors --

const testAnchor = `-----BEGIN CERTIFICATE-----
MIIBkTCB+wIJAKp0P0Example
-----END CERTIFICATE-----`

func TestTrustAnchorIsInstalledAndTheBundleRebuilt(t *testing.T) {
	env, runner := testEnv(t)
	results := applyTrustedCertificates(context.Background(), policy.Settings{
		TrustedCerts: []policy.TrustedCert{
			{Name: "odm-root-ca", CertificatePEM: testAnchor},
		},
	}, env)

	// update-ca-certificates only reads files ending in .crt.
	body := read(t, env, trustAnchorDir+"/odm-odm-root-ca.crt")
	if !strings.HasPrefix(body, "-----BEGIN CERTIFICATE-----") {
		t.Fatalf("anchor not written verbatim:\n%s", body)
	}
	if !strings.HasSuffix(body, "\n") {
		t.Error("anchor must end with a newline")
	}
	if !runner.ran("update-ca-certificates", "") {
		t.Error("the trust bundle was never rebuilt")
	}
	if statuses(results)["trusted_certificates:odm-root-ca"] != "success" {
		t.Fatalf("results = %+v", results)
	}
}

func TestSomethingThatIsNotACertificateIsSkipped(t *testing.T) {
	env, runner := testEnv(t)
	results := applyTrustedCertificates(context.Background(), policy.Settings{
		TrustedCerts: []policy.TrustedCert{{Name: "bogus", CertificatePEM: "not a certificate"}},
	}, env)

	if statuses(results)["trusted_certificates:bogus"] != "skipped" {
		t.Fatalf("results = %+v", results)
	}
	if runner.ran("update-ca-certificates", "") {
		t.Error("the bundle should not be rebuilt when nothing was installed")
	}
}

// ------------------------------------------------------------------ packages --

func TestPackagesAreInstalledUpgradedAndRemovedInOneRunEach(t *testing.T) {
	env, runner := testEnv(t)
	results := applyPackages(context.Background(), policy.Settings{
		Packages: []policy.Package{
			{Name: "cifs-utils", State: "present"},
			{Name: "curl", State: ""},
			{Name: "openssh-server", State: "latest"},
			{Name: "telnetd", State: "absent"},
		},
	}, env)

	if !runner.ran("apt-get", "update") {
		t.Error("the package index was not refreshed")
	}
	if !runner.ran("apt-get", "install cifs-utils curl") {
		t.Errorf("install batch wrong: %v", runner.commands)
	}
	if !runner.ran("apt-get", "install --only-upgrade openssh-server") {
		t.Errorf("upgrade batch wrong: %v", runner.commands)
	}
	if !runner.ran("apt-get", "remove telnetd") {
		t.Errorf("remove batch wrong: %v", runner.commands)
	}
	for setting, status := range statuses(results) {
		if status != "success" {
			t.Errorf("%s = %s", setting, status)
		}
	}
}

func TestNoPackagesMeansNoAptRun(t *testing.T) {
	env, runner := testEnv(t)
	if results := applyPackages(context.Background(), policy.Settings{}, env); results != nil {
		t.Fatalf("results = %+v", results)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("apt was run with nothing to do: %v", runner.commands)
	}
}

// A file ODM only keeps a block inside belongs to the system. Pruning one
// took /etc/pam.d/common-account off a machine because a policy stopped
// mentioning it, and with it every way of authenticating.
func TestPruningAFileODMOnlyEditedTakesTheBlockNotTheFile(t *testing.T) {
	root := t.TempDir()
	runner := &fakeRunner{}
	stack := "/etc/pam.d/common-account"

	first := Env{Root: root, Run: runner, State: NewState()}
	if err := first.WriteFile(stack, "# the system's own stack\naccount required pam_unix.so\n",
		0o644, "", ""); err != nil {
		t.Fatal(err)
	}
	// Pretend the system, not ODM, wrote that: a fresh state for the run
	// that adds the block.
	second := Env{Root: root, Run: runner, State: NewState()}
	if err := second.ReplaceBlock(stack, "account required pam_access.so\n", 0o644); err != nil {
		t.Fatal(err)
	}
	if !second.State.Blocks[stack] {
		t.Fatal("a block edit was not recorded as one")
	}

	// A later run that no longer wants the block.
	third := Env{Root: root, Run: runner, State: NewState()}
	third.Prune(second.State)

	body, err := os.ReadFile(filepath.Join(root, stack))
	if err != nil {
		t.Fatalf("the file was deleted rather than edited: %v", err)
	}
	if strings.Contains(string(body), "pam_access") {
		t.Errorf("the block was not removed:\n%s", body)
	}
	if !strings.Contains(string(body), "pam_unix") {
		t.Errorf("the system's own lines were lost:\n%s", body)
	}
}

// Taking a configuration file away is a change to whatever reads it, and a
// service does not notice on its own: removing the sshd drop-in that carried
// an HBAC deny left sshd refusing that user with a rule that existed nowhere
// on disk, and nothing said so.
func TestPruningAConfigFileReloadsWhatReadsIt(t *testing.T) {
	root := t.TempDir()
	runner := &fakeRunner{}
	drop := "/etc/ssh/sshd_config.d/50-odm.conf"

	first := Env{Root: root, Run: runner, State: NewState()}
	if err := first.WriteFile(drop, "DenyUsers someone\n", 0o644, "", ""); err != nil {
		t.Fatal(err)
	}

	second := Env{Root: root, Run: runner, State: NewState()}
	removed := second.Prune(first.State)
	if len(removed) != 1 {
		t.Fatalf("the drop-in was not pruned: %v", removed)
	}
	runner.commands = nil
	reloadAfterPrune(context.Background(), removed, second)

	var reloaded bool
	for _, command := range runner.commands {
		if len(command) >= 3 && command[0] == "systemctl" && command[2] == "ssh" {
			reloaded = true
		}
	}
	if !reloaded {
		t.Fatalf("ssh was not reloaded after its drop-in went away: %v", runner.commands)
	}
}

// ServerName in client.conf makes every CUPS command on the machine talk to
// the print server instead of to itself, so lpadmin tried to create the queue
// on the server and the server refused it: "lpadmin: Forbidden". The queues a
// policy names are local ones pointing at the server.
func TestPrintersAreLocalQueuesPointingAtTheServer(t *testing.T) {
	env, runner := testEnv(t)
	// A machine with no CUPS has nothing to add a queue to, and says so.
	if err := env.WriteFile("/usr/sbin/cupsd", "", 0o755, "", ""); err != nil {
		t.Fatal(err)
	}
	applyPrinters(context.Background(), policy.Settings{
		Printers: []policy.Printer{
			{Name: "finance-mfp", Server: "print01.corp.example.internal"},
		},
	}, env)

	var created bool
	for _, command := range runner.commands {
		if len(command) > 5 && command[0] == "lpadmin" {
			created = true
			joined := strings.Join(command, " ")
			if !strings.Contains(joined, "ipp://print01.corp.example.internal/printers/finance-mfp") {
				t.Errorf("the queue does not point at the server: %v", command)
			}
		}
	}
	if !created {
		t.Fatalf("no queue was created: %v", runner.commands)
	}
	if body, err := os.ReadFile(filepath.Join(env.Root, "/etc/cups/client.conf")); err == nil {
		if strings.Contains(string(body), "ServerName") {
			t.Errorf("client.conf still redirects every CUPS command:\n%s", body)
		}
	}
}

// A machine that has no CUPS cannot be given a printer, and should say that
// rather than fail on a command that is not there.
func TestPrintersAreSkippedWhereCupsIsNotInstalled(t *testing.T) {
	env, _ := testEnv(t)
	results := applyPrinters(context.Background(), policy.Settings{
		Printers: []policy.Printer{{Name: "finance-mfp", Server: "print01"}},
	}, env)
	if len(results) != 1 || results[0].Status != "skipped" {
		t.Fatalf("expected one skip, got %+v", results)
	}
}

// The background used to be a URI and nothing else, so a policy that set one
// pointed the desktop at a path no machine had a picture at: everybody got the
// blank blue fallback and the setting reported success.
func TestAWallpaperArrivesWithItsPicture(t *testing.T) {
	env, _ := testEnv(t)
	png := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\ncontent"))
	results := applyWallpaper(context.Background(), policy.Settings{
		Wallpaper: &policy.Wallpaper{Image: png, ImageName: "corp.png"},
	}, env)
	for _, result := range results {
		if result.Status == "failed" {
			t.Fatalf("wallpaper failed: %s", result.Reason)
		}
	}
	if got := read(t, env, BackgroundDir+"/corp.png"); !strings.Contains(got, "content") {
		t.Fatalf("the picture was not written: %q", got)
	}
	if keyfile := read(t, env, dconfKeyfilePath); !strings.Contains(
		keyfile, "file://"+BackgroundDir+"/corp.png",
	) {
		t.Fatalf("dconf does not point at the picture:\n%s", keyfile)
	}
}

// A home directory owned by a uid no account has is the state a restored or
// recreated user lands in, and it makes the whole desktop unusable.
func TestTheSessionHookRepairsAnOrphanedHome(t *testing.T) {
	env, _ := testEnv(t)
	if result := installSessionHook(env); result.Status != "success" {
		t.Fatalf("hook not installed: %s", result.Reason)
	}
	hook := read(t, env, pamHookPath)
	for _, want := range []string{"odm_repair_home", "getent passwd \"$owner\"", "chown -R"} {
		if !strings.Contains(hook, want) {
			t.Fatalf("the hook does not repair a stale home (%q missing):\n%s", want, hook)
		}
	}
}

func TestAProfilePathNamesTheShareAndThePersonsPlaceInIt(t *testing.T) {
	for _, want := range []struct{ in, share, sub string }{
		{`//fs01/profiles`, "//fs01/profiles", ""},
		{`//fs01/profiles/%username%`, "//fs01/profiles", "t.tester"},
		{`\\fs01\profiles\team\%username%`, "//fs01/profiles", "team/t.tester"},
	} {
		share, sub, err := splitProfilePath(want.in, "T.Tester")
		if err != nil || share != want.share || sub != want.sub {
			t.Fatalf("%q gave (%q, %q, %v)", want.in, share, sub, err)
		}
	}
	for _, bad := range []string{"/srv/profiles", "//fs01", "//fs01/p/../etc"} {
		if _, _, err := splitProfilePath(bad, "t.tester"); err == nil {
			t.Fatalf("%q was accepted", bad)
		}
	}
}

// A stylesheet inside a dconf database directory makes "dconf update" fail on
// the whole database, so the banner and the user-list setting went down with
// the background.
func TestTheGreeterStylesheetIsNotInsideTheDconfDatabase(t *testing.T) {
	env, _ := testEnv(t)
	png := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nx"))
	results := applyLoginScreen(context.Background(), policy.Settings{
		LoginScreen: &policy.LoginScreen{
			BannerText: "Example Corp", BackgroundImage: png, BackgroundImageName: "g.png",
		},
	}, env)
	for _, result := range results {
		if result.Status == "failed" {
			t.Fatalf("login screen failed: %s: %s", result.Setting, result.Reason)
		}
	}
	if strings.HasPrefix(greeterCssPath, "/etc/dconf/") {
		t.Fatalf("the stylesheet is in a dconf database directory: %s", greeterCssPath)
	}
	keyfile := read(t, env, greeterKeyfilePath)
	if !strings.Contains(keyfile, "[org/gnome/desktop/background]") {
		t.Fatalf("the greeter has no background key:\n%s", keyfile)
	}
}
