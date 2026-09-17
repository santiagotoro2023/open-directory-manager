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

	"odm.example.org/agent/internal/apply"
)

func TestThePasswordManagerIsConfiguredAndItsSyncWiredToTheGroups(t *testing.T) {
	run := &recorder{}
	env := apply.Env{Root: t.TempDir(), Run: run}
	env.Certificate = func(_ context.Context, profile string) (string, string, string, error) {
		return "CERT-" + profile, "KEY", "CA", nil
	}
	_ = os.MkdirAll(env.Path("/etc/containers/systemd"), 0o755)
	_ = os.WriteFile(env.Path("/etc/containers/systemd/vaultwarden.container"), []byte("[Container]\n"), 0o644)
	_ = os.MkdirAll(env.Path("/etc/odm/vaultwarden/tls"), 0o755)
	_ = os.WriteFile(env.Path("/etc/odm/vaultwarden/env"), []byte("DOMAIN=https://old\nADMIN_TOKEN=secret\nROCKET_TLS={certs=\"/tls/server.pem\",key=\"/tls/server.key\"}\n"), 0o600)
	_ = os.MkdirAll(env.Path("/opt/odm/bwdc"), 0o755)
	_ = os.WriteFile(env.Path("/opt/odm/bwdc/bwdc"), []byte("#!/bin/sh\n"), 0o755)

	out, err := applyPasswordManager(context.Background(), map[string]any{
		"vault_url": "https://vault.corp.example.internal", "server_certificate": true,
		"org_client_id": "organization.abc", "org_client_secret": "s3cret",
		"ldap_host": "dc1.corp.example.internal", "base_dn": "DC=corp,DC=example,DC=internal",
		"sync_account": "odm-passwords-sync@corp.example.internal", "sync_password": "pw",
		"sync_groups":      []any{"Sales", "IT-admins"},
		"sync_group_dns":   []any{"CN=Sales,OU=People,DC=corp,DC=example,DC=internal", "CN=IT-admins,OU=People,DC=corp,DC=example,DC=internal"},
		"sync_every_hours": float64(2), "sync_now": true, "mail_domain": "corp.example.internal",
		"sso_enabled": true, "sso_only": true, "sso_authority": "https://odm.corp.example.internal:8443/api/v1/oidc",
		"sso_client_id": "vaultwarden", "sso_client_secret": "sso-secret",
		"smtp_host": "mail.corp.example.internal", "smtp_port": float64(587), "smtp_from": "vault@corp.example.internal",
	}, env, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "certificate from the domain authority") || !strings.Contains(out, "synced 2 group(s)") {
		t.Errorf("summary: %s", out)
	}
	if cert, _ := os.ReadFile(env.Path(vaultCertPath)); string(cert) != "CERT-server" {
		t.Error("the server certificate was not written")
	}
	envFile, _ := os.ReadFile(env.Path(vaultEnvPath))
	for _, want := range []string{"DOMAIN=https://vault.corp.example.internal", "ADMIN_TOKEN=secret", "SMTP_HOST=mail.corp.example.internal", "SMTP_SECURITY=starttls", "ROCKET_TLS=",
		"SSO_ENABLED=true", "SSO_ONLY=true", "SSO_AUTHORITY=https://odm.corp.example.internal:8443/api/v1/oidc",
		"SSO_CLIENT_SECRET=sso-secret", "SSO_AUTH_ONLY_NOT_SESSION=true", "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
		"SIGNUPS_DOMAINS_WHITELIST=corp.example.internal"} {
		if !strings.Contains(string(envFile), want) {
			t.Errorf("env lacks %q:\n%s", want, envFile)
		}
	}
	if strings.Contains(string(envFile), "DOMAIN=https://old") {
		t.Error("the old DOMAIN line survived")
	}
	configured := map[string]string{}
	for _, call := range run.calls {
		if strings.HasSuffix(call[0], "/bwdc") && len(call) >= 4 && call[1] == "config" {
			configured[call[2]] = call[3]
		}
	}
	if configured["ldap.hostname"] != "dc1.corp.example.internal" || configured["ldap.ad"] != "true" || configured["ldap.username"] != "odm-passwords-sync@corp.example.internal" {
		t.Errorf("ldap settings: %v", configured)
	}
	if configured["sync.groupFilter"] != "(|(cn=Sales)(cn=IT-admins))" {
		t.Errorf("group filter: %q", configured["sync.groupFilter"])
	}
	if configured["sync.useEmailPrefixSuffix"] != "true" || configured["sync.emailSuffix"] != "@corp.example.internal" {
		t.Errorf("an account without a mail address must be invited as sam@domain: %v", configured)
	}
	if !strings.HasPrefix(configured["sync.userFilter"], "(|(memberOf=CN=Sales,") {
		t.Errorf("user filter: %q", configured["sync.userFilter"])
	}
	apikey, _ := os.ReadFile(env.Path(bwdcHome + "/apikey.env"))
	if !strings.Contains(string(apikey), "BW_CLIENTSECRET=s3cret") {
		t.Error("the organisation key was not written for the timer")
	}
	timer, _ := os.ReadFile(env.Path(bwdcTimer))
	if !strings.Contains(string(timer), "OnUnitActiveSec=2h") {
		t.Errorf("timer:\n%s", timer)
	}
	restarted, started := false, false
	for _, call := range run.calls {
		line := strings.Join(call, " ")
		if strings.Contains(line, "restart vaultwarden.service") {
			restarted = true
		}
		if strings.Contains(line, "start odm-bwdc-sync.service") {
			started = true
		}
	}
	if !restarted || !started {
		t.Errorf("vault restarted %v, sync started %v: %v", restarted, started, run.calls)
	}
}

func TestWithoutAnOrganisationKeyOnlyTheVaultIsConfigured(t *testing.T) {
	run := &recorder{}
	env := apply.Env{Root: t.TempDir(), Run: run}
	_ = os.MkdirAll(env.Path("/etc/containers/systemd"), 0o755)
	_ = os.WriteFile(env.Path("/etc/containers/systemd/vaultwarden.container"), []byte(""), 0o644)
	_ = os.MkdirAll(env.Path("/etc/odm/vaultwarden"), 0o755)
	out, err := applyPasswordManager(context.Background(), map[string]any{"vault_url": "https://vault.example"}, env, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "no organisation key") {
		t.Errorf("summary: %s", out)
	}
	for _, call := range run.calls {
		if strings.Contains(strings.Join(call, " "), "bwdc") && !strings.Contains(strings.Join(call, " "), "disable") {
			t.Errorf("the connector must not be touched: %v", call)
		}
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
