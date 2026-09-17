package tasks

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"strings"
	"time"

	"odm.example.org/agent/internal/apply"
)

// The password-manager role's configuration, applied.
//
// Two things reach the node here. The vault's TLS certificate: issued by the
// domain authority, so the console can verify the node it forwards to and
// every domain member trusts the vault. And the vault's settings: its
// public address (the console's), sign-in through the console's OpenID
// provider and nothing else, sign-ups closed. Who has a seat, which
// collections exist and who sees them is the console's business, done
// through the vault's own API from the console (vaultkeeper.py) — nothing
// about that lives on this node.

const (
	vaultConf     = "/etc/odm/vaultwarden"
	vaultEnvPath  = vaultConf + "/env"
	vaultCertPath = vaultConf + "/tls/server.pem"
	vaultKeyPath  = vaultConf + "/tls/server.key"
)

func applyPasswordManager(ctx context.Context, payload map[string]any, env apply.Env, _ Progress) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	if _, err := os.Stat(env.Path("/etc/containers/systemd/vaultwarden.container")); err != nil {
		return "", fmt.Errorf("the password-manager role is not installed on this machine")
	}
	vaultURL, _ := payload["vault_url"].(string)
	if !strings.HasPrefix(vaultURL, "https://") || strings.ContainsAny(vaultURL, " \n\"'") {
		return "", fmt.Errorf("the vault's address %q is not an https:// address", vaultURL)
	}
	var notes []string

	// The certificate, from the domain authority where there is one — asked
	// for once, not at every apply: the one on disk is kept while it is the
	// authority's and has more than a month to run, or every Save on the
	// Passwords page would put another certificate on the authority's list.
	if boolean(payload["server_certificate"], false) && env.Certificate != nil &&
		vaultCertificateUsable(env.Path(vaultCertPath), time.Now()) {
		env.Keep(vaultCertPath)
		env.Keep(vaultKeyPath)
		notes = append(notes, "certificate from the domain authority (kept)")
	} else if boolean(payload["server_certificate"], false) && env.Certificate != nil {
		certPEM, keyPEM, _, err := env.Certificate(ctx, "server")
		if err != nil {
			notes = append(notes, fmt.Sprintf("certificate not issued: %v", err))
		} else if err := env.WriteFile(vaultKeyPath, keyPEM, 0o640, "root", "root"); err != nil {
			return "", err
		} else if err := env.WriteFile(vaultCertPath, certPEM, 0o644, "root", "root"); err != nil {
			return "", err
		} else {
			notes = append(notes, "certificate from the domain authority")
		}
	}

	// The service's settings. The token and the TLS lines stay as the
	// installer wrote them; everything the console decides is rewritten.
	existing, _ := os.ReadFile(env.Path(vaultEnvPath))
	var kept []string
	for _, line := range strings.Split(string(existing), "\n") {
		key, _, _ := strings.Cut(line, "=")
		switch key {
		case "DOMAIN", "SMTP_HOST", "SMTP_PORT", "SMTP_FROM", "SMTP_USERNAME", "SMTP_PASSWORD",
			"SMTP_SECURITY", "SIGNUPS_ALLOWED", "INVITATIONS_ALLOWED", "ORG_GROUPS_ENABLED",
			"SSO_ENABLED", "SSO_ONLY", "SSO_AUTHORITY", "SSO_CLIENT_ID", "SSO_CLIENT_SECRET",
			"SSO_SIGNUPS_MATCH_EMAIL", "SSO_AUTH_ONLY_NOT_SESSION", "SSO_SCOPES",
			"SSO_CLIENT_CACHE_EXPIRATION", "SSL_CERT_FILE", "SIGNUPS_DOMAINS_WHITELIST",
			"SSO_SIGNUPS_ALLOWED", "":
			continue
		}
		kept = append(kept, line)
	}
	// Sign-ups closed and no mail: a seat is an invitation the console
	// makes, and the vault accepts it by itself at the person's first
	// sign-in (with mail switched on it would wait for a link instead, and
	// the console could never confirm anyone). Sign-in only through the
	// console: the console is the domain's OpenID provider, and the only
	// door. SSO_AUTH_ONLY_NOT_SESSION leaves the vault's own sessions to
	// the vault; SSL_CERT_FILE is the machine's bundle, which the container
	// carries and which trusts the domain authority the console's
	// certificate comes from.
	lines := []string{
		"# Managed by Open Directory Manager. Local edits are overwritten.",
		"DOMAIN=" + vaultURL,
		"SIGNUPS_ALLOWED=false",
		"INVITATIONS_ALLOWED=true",
		"ORG_GROUPS_ENABLED=true",
	}
	if authority, _ := payload["sso_authority"].(string); authority != "" && !strings.ContainsAny(authority, " \n\"'") {
		ssoID, _ := payload["sso_client_id"].(string)
		ssoSecret, _ := payload["sso_client_secret"].(string)
		lines = append(lines,
			"SSO_ENABLED=true",
			"SSO_ONLY=true",
			"SSO_AUTHORITY="+authority,
			"SSO_CLIENT_ID="+ssoID,
			"SSO_CLIENT_SECRET="+ssoSecret,
			"SSO_SIGNUPS_MATCH_EMAIL=true",
			"SSO_AUTH_ONLY_NOT_SESSION=true",
			"SSO_SCOPES=profile email",
			"SSO_CLIENT_CACHE_EXPIRATION=3600",
			"SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
		)
		notes = append(notes, "sign-in through the console")
	} else {
		return "", fmt.Errorf("the console sent no OpenID provider for the vault to sign people in with")
	}
	body := strings.Join(append(lines, kept...), "\n") + "\n"
	if err := env.WriteFile(vaultEnvPath, body, 0o600, "root", "root"); err != nil {
		return "", fmt.Errorf("writing %s: %w", vaultEnvPath, err)
	}
	if _, err := env.Run.Run(ctx, "systemctl", "restart", "vaultwarden.service"); err != nil {
		return "", fmt.Errorf("restarting the vault: %w", err)
	}
	// The admin page's token, made by the installer and printed once there:
	// reported to the console so the Passwords page can show it, rather
	// than asking an operator to go and read a file on the server.
	if token, err := os.ReadFile(env.Path(vaultConf + "/admin-token")); err == nil {
		if trimmed := strings.TrimSpace(string(token)); trimmed != "" && !strings.ContainsAny(trimmed, " \n") {
			notes = append(notes, "admin_token="+trimmed)
		}
	}

	return "vault configured (" + strings.Join(notes, "; ") + ")", nil
}

// vaultCertificateUsable reports whether the certificate at path is one
// worth keeping: issued by something other than itself, and valid for more
// than thirty days from now. The installer's self-signed one, or one
// nearing its end, is replaced.
func vaultCertificateUsable(path string, now time.Time) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return false
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return false
	}
	if cert.Issuer.String() == cert.Subject.String() {
		return false
	}
	return cert.NotAfter.After(now.Add(30 * 24 * time.Hour))
}
