package join

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A certificate to stand in for the console's, made here so the test needs no
// fixture file.
func selfSigned(t *testing.T) string {
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

// smbclient is faked, so what it would have written is put there first.
func stage(t *testing.T, env Env, body string) {
	t.Helper()
	path := env.Path(CACertPath + ".fetched")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The whole point: a join needs the domain and a credential, nothing else.
// The certificate the agent verifies the console with comes from SYSVOL over
// Kerberos, where the controller proves itself with the KDC rather than with
// the certificate being fetched.
func TestTheConsoleCertificateComesFromTheDomain(t *testing.T) {
	env, runner := testEnv(t)
	options := Options{Domain: "corp.example.internal", Realm: "CORP.EXAMPLE.INTERNAL"}
	certificate := selfSigned(t)
	stage(t, env, certificate)

	anchor, err := FetchTrustAnchor(context.Background(), options, "dc1.corp.example.internal", env)
	if err != nil {
		t.Fatalf("fetching the anchor: %v", err)
	}
	if anchor != CACertPath {
		t.Errorf("anchor = %q, want %q", anchor, CACertPath)
	}
	if got := read(t, env, CACertPath); got != certificate {
		t.Errorf("the certificate was not installed:\n%s", got)
	}

	// The machine's own account, Kerberos required, and the domain's own
	// directory inside the share.
	if !runner.ran("smbclient", "--machine-pass") ||
		!runner.ran("smbclient", "--use-kerberos=required") {
		t.Errorf("not fetched as this machine over Kerberos: %v", runner.commands)
	}
	if !runner.ran("smbclient", `"corp.example.internal/odm/api-ca.pem"`) {
		t.Errorf("wrong path inside SYSVOL: %v", runner.commands)
	}
	if !runner.ran("smbclient", "//dc1.corp.example.internal/sysvol") {
		t.Errorf("not read from the controller that was joined: %v", runner.commands)
	}
}

func TestACertificateGivenOnTheCommandLineWins(t *testing.T) {
	env, runner := testEnv(t)
	options := Options{Domain: "corp.example.internal", CACert: "/tmp/console.crt"}

	anchor, err := FetchTrustAnchor(context.Background(), options, "dc1", env)
	if err != nil || anchor != "/tmp/console.crt" {
		t.Fatalf("anchor = %q, err = %v", anchor, err)
	}
	if len(runner.commands) != 0 {
		t.Errorf("nothing should be fetched: %v", runner.commands)
	}
}

// Whatever is in SYSVOL is verified before this machine trusts it.
func TestSomethingThatIsNotACertificateIsRefused(t *testing.T) {
	env, _ := testEnv(t)
	options := Options{Domain: "corp.example.internal"}
	stage(t, env, "not a certificate at all\n")

	if _, err := FetchTrustAnchor(context.Background(), options, "dc1", env); err == nil {
		t.Fatal("a file that is not a certificate must be refused")
	}
	if _, err := os.Stat(env.Path(CACertPath)); err == nil {
		t.Error("it must not be installed either")
	}
}

func TestWithoutSmbclientTheReasonIsNamed(t *testing.T) {
	env, runner := testEnv(t)
	runner.fail["sh"] = "not found"
	options := Options{Domain: "corp.example.internal"}

	_, err := FetchTrustAnchor(context.Background(), options, "dc1", env)
	if err == nil || !strings.Contains(err.Error(), "smbclient") {
		t.Fatalf("err = %v, want one naming smbclient", err)
	}
}
