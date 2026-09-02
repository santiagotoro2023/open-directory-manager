package trust

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"odm.example.org/agent/internal/apply"
	"odm.example.org/agent/internal/config"
)

type fakeRunner struct {
	commands [][]string
	fail     bool
	// failFirst refuses the first smbclient and accepts what comes after, the
	// way a machine whose secrets database will not open behaves.
	failFirst bool
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	f.commands = append(f.commands, append([]string{name}, args...))
	if f.fail {
		return "NT_STATUS_ACCESS_DENIED", fmt.Errorf("smbclient failed")
	}
	if f.failFirst && name == "smbclient" {
		f.failFirst = false
		return "ldb: Unable to open tdb '/var/lib/samba/private/secrets.ldb'",
			fmt.Errorf("smbclient failed")
	}
	return "", nil
}

func certificate(t *testing.T) string {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "odm.corp.example.internal"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func machine(t *testing.T) (apply.Env, *fakeRunner, string) {
	t.Helper()
	root := t.TempDir()
	runner := &fakeRunner{}
	env := apply.Env{Root: root, Run: runner, State: apply.NewState()}

	// smbclient is faked, so both its presence and what it would have written
	// are arranged here.
	write(t, filepath.Join(root, "usr/bin/smbclient"), "#!/bin/sh\n")

	configPath := "/etc/odm/agent.json"
	write(t, filepath.Join(root, configPath), `{
  "api_url": "https://odm.corp.example.internal:8443",
  "service_principal": "HTTP/odm.corp.example.internal",
  "keytab": "/etc/krb5.keytab",
  "realm": "CORP.EXAMPLE.INTERNAL"
}
`)
	return env, runner, configPath
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The certificate a machine verifies the console with is published in SYSVOL
// and fetched as this machine, so nothing has to be carried to it by hand.
func TestTheCertificateIsFetchedFromTheDomainAndRecorded(t *testing.T) {
	env, runner, configPath := machine(t)
	pemBody := certificate(t)
	write(t, env.Path(Path+".fetched"), pemBody)

	got, err := FromDomain(context.Background(), config.Config{
		Realm:  "CORP.EXAMPLE.INTERNAL",
		APIURL: "https://dc1.corp.example.internal:8443",
	}, configPath, env)
	if err != nil {
		t.Fatalf("FromDomain: %v", err)
	}
	if got != Path {
		t.Errorf("path = %q, want %q", got, Path)
	}

	// Fetched from a controller by name — never from the domain name, which
	// has no host principal and failed before a share was ever opened — as
	// this machine, over Kerberos.
	command := fmt.Sprint(runner.commands)
	for _, want := range []string{
		"//dc1.corp.example.internal/sysvol", "--machine-pass", "--use-kerberos=required",
		"corp.example.internal/odm/api-ca.pem",
	} {
		if !strings.Contains(command, want) {
			t.Errorf("%q missing from %s", want, command)
		}
	}

	if body, err := os.ReadFile(env.Path(Path)); err != nil || string(body) != pemBody {
		t.Errorf("the certificate was not installed: %v", err)
	}

	// And the configuration now names it, or the next run would fetch it again.
	raw, err := os.ReadFile(env.Path(configPath))
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if fields["ca_cert"] != Path {
		t.Errorf("ca_cert = %v, want %s", fields["ca_cert"], Path)
	}
	if fields["realm"] != "CORP.EXAMPLE.INTERNAL" {
		t.Errorf("the rest of the configuration was not left alone: %v", fields)
	}
}

func TestAnythingThatIsNotACertificateIsRefused(t *testing.T) {
	env, _, configPath := machine(t)
	write(t, env.Path(Path+".fetched"), "hello\n")

	_, err := FromDomain(context.Background(), config.Config{
		Realm: "CORP.EXAMPLE.INTERNAL", APIURL: "https://dc1.corp.example.internal:8443",
	}, configPath, env)
	if err == nil {
		t.Fatal("a file that is not a certificate must be refused")
	}
	if _, err := os.Stat(env.Path(Path)); err == nil {
		t.Error("and must not be installed")
	}
}

func TestASmbclientFailureIsReportedWithWhatItSaid(t *testing.T) {
	env, runner, configPath := machine(t)
	runner.fail = true

	_, err := FromDomain(context.Background(), config.Config{
		Realm: "CORP.EXAMPLE.INTERNAL", APIURL: "https://dc1.corp.example.internal:8443",
	}, configPath, env)
	if err == nil || !strings.Contains(err.Error(), "ACCESS_DENIED") {
		t.Fatalf("err = %v, want one carrying what smbclient said", err)
	}
}

// Only a certificate that will not verify is healed this way. Anything else —
// a refused ticket, a name that does not resolve — is a different problem and
// re-fetching the certificate would not touch it.
func TestOnlyAVerificationFailureCountsAsUntrusted(t *testing.T) {
	if Untrusted(nil) {
		t.Error("no error is not a trust failure")
	}
	if Untrusted(errors.New("connection refused")) {
		t.Error("a refused connection is not a trust failure")
	}
	if !Untrusted(&tls.CertificateVerificationError{Err: errors.New("x509: unknown authority")}) {
		t.Error("a verification failure is one")
	}
	if !Untrusted(fmt.Errorf("get policy: %w", x509.UnknownAuthorityError{})) {
		t.Error("an unknown authority is one, however it is wrapped")
	}
}

// The keytab as the second way in. A machine whose secrets database smbclient
// will not read — "Unable to open tdb secrets.ldb" — still holds the keytab
// the agent authenticates with everywhere else, so the fetch asks for a
// ticket of its own and tries again rather than giving up.
func TestTheKeytabIsTheSecondWayIn(t *testing.T) {
	env, runner, configPath := machine(t)
	runner.failFirst = true
	write(t, env.Path(Path+".fetched"), certificate(t))

	if _, err := FromDomain(context.Background(), config.Config{
		Realm: "CORP.EXAMPLE.INTERNAL", APIURL: "https://dc1.corp.example.internal:8443",
	}, configPath, env); err != nil {
		t.Fatalf("FromDomain: %v", err)
	}

	command := fmt.Sprint(runner.commands)
	if !strings.Contains(command, "kinit") {
		t.Errorf("no ticket was asked for: %s", command)
	}
	if !strings.Contains(command, "KRB5CCNAME=FILE:") {
		t.Errorf("the second attempt did not use that ticket: %s", command)
	}
}
