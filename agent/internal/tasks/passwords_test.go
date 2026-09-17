package tasks

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
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

func TestTheVaultIsConfiguredForSignInThroughTheConsole(t *testing.T) {
	env, run := testEnv(t)
	if err := os.MkdirAll(env.Path(vaultConf+"/tls"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(env.Path("/etc/containers/systemd"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(env.Path("/etc/containers/systemd/vaultwarden.container"), []byte("[Container]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(env.Path(vaultEnvPath), []byte("DOMAIN=old\nADMIN_TOKEN=secret\nROCKET_TLS={certs=\"/tls/server.pem\",key=\"/tls/server.key\"}\nSMTP_HOST=gone\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(env.Path(vaultConf+"/admin-token"), []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	env.Certificate = func(_ context.Context, profile string) (string, string, string, error) {
		return "-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----\n", "key", "", nil
	}
	out, err := applyPasswordManager(context.Background(), map[string]any{
		"vault_url": "https://odm.corp.example.internal:8443/vault", "server_certificate": true,
		"sso_authority": "https://odm.corp.example.internal:8443/api/v1/oidc",
		"sso_client_id": "password-manager", "sso_client_secret": "sso-secret",
	}, env, nil)
	if err != nil {
		t.Fatal(err)
	}
	envFile, _ := os.ReadFile(env.Path(vaultEnvPath))
	for _, want := range []string{
		"DOMAIN=https://odm.corp.example.internal:8443/vault", "ADMIN_TOKEN=secret", "ROCKET_TLS=",
		"SIGNUPS_ALLOWED=false", "INVITATIONS_ALLOWED=true",
		"SSO_ENABLED=true", "SSO_ONLY=true", "SSO_AUTHORITY=https://odm.corp.example.internal:8443/api/v1/oidc",
		"SSO_CLIENT_SECRET=sso-secret", "SSO_AUTH_ONLY_NOT_SESSION=true", "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
	} {
		if !strings.Contains(string(envFile), want) {
			t.Errorf("env lacks %q:\n%s", want, envFile)
		}
	}
	for _, gone := range []string{"SMTP_HOST", "SIGNUPS_DOMAINS_WHITELIST", "DOMAIN=old"} {
		if strings.Contains(string(envFile), gone) {
			t.Errorf("env still has %q:\n%s", gone, envFile)
		}
	}
	if !strings.Contains(out, "admin_token=secret") || !strings.Contains(out, "certificate from the domain authority") {
		t.Errorf("summary: %s", out)
	}
	restarted := false
	for _, call := range run.commands {
		if strings.Join(call, " ") == "systemctl restart vaultwarden.service" {
			restarted = true
		}
		if strings.Contains(strings.Join(call, " "), "bwdc") {
			t.Errorf("the directory connector is gone, but: %v", call)
		}
	}
	if !restarted {
		t.Error("the vault was not restarted")
	}
	if _, err := applyPasswordManager(context.Background(), map[string]any{"vault_url": "https://x/vault"}, env, nil); err == nil {
		t.Error("a configuration without the OpenID provider must be refused")
	}
}

func TestTheVaultKeepsACertificateTheAuthorityIssuedAndReplacesItsOwn(t *testing.T) {
	dir := t.TempDir()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Example CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(10 * 365 * 24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	caCert, _ := x509.ParseCertificate(caDER)
	leafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	write := func(name string, template, parent *x509.Certificate, key *ecdsa.PrivateKey) string {
		der, err := x509.CreateCertificate(rand.Reader, template, parent, &leafKey.PublicKey, key)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	issued := write("issued.pem", &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "vault.example"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(365 * 24 * time.Hour),
	}, caCert, caKey)
	expiring := write("expiring.pem", &x509.Certificate{
		SerialNumber: big.NewInt(3), Subject: pkix.Name{CommonName: "vault.example"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(10 * 24 * time.Hour),
	}, caCert, caKey)
	selfTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(4), Subject: pkix.Name{CommonName: "vault.example"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(365 * 24 * time.Hour),
	}
	self := write("self.pem", selfTemplate, selfTemplate, leafKey)

	if !vaultCertificateUsable(issued, time.Now()) {
		t.Error("a certificate from the authority with a year to run must be kept")
	}
	if vaultCertificateUsable(expiring, time.Now()) {
		t.Error("a certificate with ten days to run must be replaced")
	}
	if vaultCertificateUsable(self, time.Now()) {
		t.Error("the installer's self-signed certificate must be replaced")
	}
	if vaultCertificateUsable(filepath.Join(dir, "missing.pem"), time.Now()) {
		t.Error("no certificate is not a usable one")
	}
}
