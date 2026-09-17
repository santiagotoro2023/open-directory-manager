package tasks

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"odm.example.org/agent/internal/apply"
)

// The password-manager role's configuration, applied.
//
// Three things reach the node here, each on its own. The vault's TLS
// certificate: issued by the domain authority when there is one, so every
// domain member — and the browser extension — trusts the vault without a
// warning. The vault's settings: its public address and, when given, the
// mail relay it invites people through. And the directory sync: Bitwarden's
// own directory connector (bwdc), fetched once, configured against the
// domain with the read-only account the console made, signed in with the
// organisation's API key, run now and then on a timer — which is what turns
// "in the Sales group" into "has a seat, and is in the Sales group of the
// organisation", so the organisation's administrator can give that group
// its collection once and never touch membership again.

const (
	vaultConf     = "/etc/odm/vaultwarden"
	vaultEnvPath  = vaultConf + "/env"
	vaultCertPath = vaultConf + "/tls/server.pem"
	vaultKeyPath  = vaultConf + "/tls/server.key"
	bwdcHome      = "/var/lib/odm/bwdc"
	bwdcDir       = "/opt/odm/bwdc"
	bwdcBinary    = bwdcDir + "/bwdc"
	bwdcUnit      = "/etc/systemd/system/odm-bwdc-sync.service"
	bwdcTimer     = "/etc/systemd/system/odm-bwdc-sync.timer"
	bwdcReleases  = "https://github.com/bitwarden/directory-connector/releases"
)

var (
	groupNameRE = regexp.MustCompile(`^[A-Za-z0-9._ -]{1,64}$`)
	dnRE        = regexp.MustCompile("^[A-Za-z0-9=,._ @&()\\\\-]{3,1000}$")
)

func applyPasswordManager(ctx context.Context, payload map[string]any, env apply.Env, progress Progress) (string, error) {
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
			"SSO_CLIENT_CACHE_EXPIRATION", "SSL_CERT_FILE", "SIGNUPS_DOMAINS_WHITELIST", "":
			continue
		}
		kept = append(kept, line)
	}
	lines := []string{
		"# Managed by Open Directory Manager. Local edits are overwritten.",
		"DOMAIN=" + vaultURL,
		"SIGNUPS_ALLOWED=false",
		"INVITATIONS_ALLOWED=true",
		"ORG_GROUPS_ENABLED=true",
	}
	// A domain account is a vault account: anyone the console signs in
	// with an address at the domain may create theirs at that first sign-in,
	// invited or not — and with sign-in through the console the only way to
	// hold such an address is to have the domain account. Nobody else can
	// sign up, which SIGNUPS_ALLOWED=false above says.
	mailDomain, _ := payload["mail_domain"].(string)
	if strings.ContainsAny(mailDomain, " \n\"'@") {
		mailDomain = ""
	}
	if mailDomain != "" {
		lines = append(lines, "SIGNUPS_DOMAINS_WHITELIST="+mailDomain)
	}
	if host, _ := payload["smtp_host"].(string); host != "" && !strings.ContainsAny(host, " \n\"'") {
		port := intOf(payload["smtp_port"], 587)
		from, _ := payload["smtp_from"].(string)
		user, _ := payload["smtp_username"].(string)
		pass, _ := payload["smtp_password"].(string)
		security := "starttls"
		if port == 465 {
			security = "force_tls"
		}
		lines = append(lines,
			"SMTP_HOST="+host,
			"SMTP_PORT="+strconv.Itoa(port),
			"SMTP_SECURITY="+security,
			"SMTP_FROM="+from,
		)
		if user != "" {
			lines = append(lines, "SMTP_USERNAME="+user, "SMTP_PASSWORD="+pass)
		}
		notes = append(notes, "mail through "+host)
	}
	// Single sign-on: the console is the domain's OpenID provider, and the
	// vault sends people there to sign in with their domain account.
	// SSO_AUTH_ONLY_NOT_SESSION leaves the vault's own sessions to the
	// vault, so the console is asked once at sign-in rather than at every
	// token refresh; SSL_CERT_FILE is the machine's own bundle, which the
	// container carries (see the quadlet) and which trusts the domain
	// authority the console's certificate comes from.
	if authority, _ := payload["sso_authority"].(string); boolean(payload["sso_enabled"], false) &&
		authority != "" && !strings.ContainsAny(authority, " \n\"'") {
		ssoID, _ := payload["sso_client_id"].(string)
		ssoSecret, _ := payload["sso_client_secret"].(string)
		lines = append(lines,
			"SSO_ENABLED=true",
			"SSO_ONLY="+strconv.FormatBool(boolean(payload["sso_only"], false)),
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
		lines = append(lines, "SSO_ENABLED=false")
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

	// The directory sync, when the organisation's key is known.
	clientID, _ := payload["org_client_id"].(string)
	clientSecret, _ := payload["org_client_secret"].(string)
	if clientID == "" || clientSecret == "" {
		_, _ = env.Run.Run(ctx, "systemctl", "disable", "--now", "odm-bwdc-sync.timer")
		return "vault configured (" + strings.Join(append(notes, "no organisation key yet, so no directory sync"), "; ") + ")", nil
	}
	if err := ensureBwdc(ctx, env, progress); err != nil {
		return "", err
	}
	account, _ := payload["sync_account"].(string)
	password, _ := payload["sync_password"].(string)
	host, _ := payload["ldap_host"].(string)
	baseDN, _ := payload["base_dn"].(string)
	groups, err := stringList(payload["sync_groups"], groupNameRE)
	if err != nil {
		return "", fmt.Errorf("sync groups: %w", err)
	}
	groupDNs, err := stringList(payload["sync_group_dns"], dnRE)
	if err != nil {
		return "", fmt.Errorf("sync groups: %w", err)
	}
	if account == "" || password == "" || host == "" || baseDN == "" {
		return "", fmt.Errorf("the sync's directory account was not sent")
	}
	if err := configureBwdc(ctx, env, bwdcSettings{
		vaultURL: vaultURL, clientID: clientID, clientSecret: clientSecret,
		ldapHost: host, baseDN: baseDN, account: account, password: password, groups: groups, groupDNs: groupDNs,
		mailDomain: mailDomain,
	}); err != nil {
		return "", err
	}
	hours := intOf(payload["sync_every_hours"], 1)
	if hours < 1 || hours > 168 {
		hours = 1
	}
	unit := "# Managed by Open Directory Manager.\n[Unit]\nDescription=Password manager directory sync\n\n" +
		"[Service]\nType=oneshot\nUser=root\nEnvironment=HOME=" + bwdcHome + "\n" +
		"Environment=NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt\n" +
		"EnvironmentFile=" + bwdcHome + "/apikey.env\n" +
		"ExecStart=/bin/sh -c '" + bwdcBinary + " login --apikey >/dev/null 2>&1 || true; " + bwdcBinary + " sync'\n"
	timer := "# Managed by Open Directory Manager.\n[Unit]\nDescription=Password manager directory sync, every " + strconv.Itoa(hours) + " hour(s)\n\n" +
		"[Timer]\nOnBootSec=5min\nOnUnitActiveSec=" + strconv.Itoa(hours) + "h\nAccuracySec=1min\n\n[Install]\nWantedBy=timers.target\n"
	if err := env.WriteFile(bwdcUnit, unit, 0o644, "root", "root"); err != nil {
		return "", err
	}
	if err := env.WriteFile(bwdcTimer, timer, 0o644, "root", "root"); err != nil {
		return "", err
	}
	_, _ = env.Run.Run(ctx, "systemctl", "daemon-reload")
	if _, err := env.Run.Run(ctx, "systemctl", "enable", "--now", "odm-bwdc-sync.timer"); err != nil {
		notes = append(notes, fmt.Sprintf("sync timer not enabled: %v", err))
	}
	if boolean(payload["sync_now"], false) {
		if out, err := unsandboxed(ctx, env, progress, "systemctl", "start", "odm-bwdc-sync.service"); err != nil {
			return out, fmt.Errorf("the first sync failed: %w — journalctl -u odm-bwdc-sync says why", err)
		}
		notes = append(notes, fmt.Sprintf("synced %d group(s) now", len(groups)))
	}
	return "vault configured (" + strings.Join(notes, "; ") + ")", nil
}

type bwdcSettings struct {
	vaultURL, clientID, clientSecret    string
	ldapHost, baseDN, account, password string
	groups, groupDNs                    []string
	// The domain an account without a mail address is known at: the
	// console's sign-in says sam@domain for such a person, and the sync has
	// to invite the same address, or the seat and the sign-in never meet.
	mailDomain string
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

// ensureBwdc fetches Bitwarden's directory connector once: the latest
// release's Linux build, unpacked under /opt/odm/bwdc.
func ensureBwdc(ctx context.Context, env apply.Env, progress Progress) error {
	if _, err := os.Stat(env.Path(bwdcBinary)); err == nil {
		return nil
	}
	if err := os.MkdirAll(env.Path(bwdcDir), 0o755); err != nil {
		return err
	}
	// The latest release redirects to its tag; the asset is named after it.
	location, err := env.Run.Run(ctx, "curl", "-fsSLI", "-o", "/dev/null", "-w", "%{url_effective}", bwdcReleases+"/latest")
	if err != nil {
		return fmt.Errorf("finding the directory connector's latest release: %w", err)
	}
	version := strings.TrimPrefix(strings.TrimSpace(location[strings.LastIndex(location, "/")+1:]), "v")
	if version == "" || strings.ContainsAny(version, " \n/") {
		return fmt.Errorf("could not read the directory connector's version from %q", location)
	}
	asset := fmt.Sprintf("%s/download/v%s/bwdc-linux-%s.zip", bwdcReleases, version, version)
	archive := env.Path(bwdcDir + "/bwdc.zip")
	if out, err := unsandboxed(ctx, env, progress, "curl", "-fsSL", "-o", archive, asset); err != nil {
		return fmt.Errorf("fetching %s: %w: %s", asset, err, strings.TrimSpace(out))
	}
	if out, err := env.Run.Run(ctx, "unzip", "-oq", archive, "-d", env.Path(bwdcDir)); err != nil {
		return fmt.Errorf("unpacking the directory connector: %w: %s", err, strings.TrimSpace(out))
	}
	_ = os.Remove(archive)
	_ = os.Chmod(env.Path(bwdcBinary), 0o755)
	return nil
}

// configureBwdc writes the connector's settings the way its own CLI does:
// one `bwdc config` per key, with the secrets through the same path and
// never on a command line the process list would show for a password.
func configureBwdc(ctx context.Context, env apply.Env, s bwdcSettings) error {
	if err := os.MkdirAll(env.Path(bwdcHome), 0o700); err != nil {
		return err
	}
	apikey := "BW_CLIENTID=" + s.clientID + "\nBW_CLIENTSECRET=" + s.clientSecret + "\n"
	if err := env.WriteFile(bwdcHome+"/apikey.env", apikey, 0o600, "root", "root"); err != nil {
		return err
	}
	// A UPN binds against Active Directory (and Samba) as it is.
	bind := s.account
	escape := strings.NewReplacer("(", "\\28", ")", "\\29", "*", "\\2a", "\\", "\\5c")
	groupFilter, userFilter := "", ""
	if len(s.groups) > 0 {
		parts := make([]string, 0, len(s.groups))
		for _, group := range s.groups {
			parts = append(parts, "(cn="+escape.Replace(group)+")")
		}
		groupFilter = "(|" + strings.Join(parts, "") + ")"
		// Only members of the chosen groups get a seat: without this every
		// account in the directory would be invited.
		members := make([]string, 0, len(s.groupDNs))
		for _, dn := range s.groupDNs {
			members = append(members, "(memberOf="+escape.Replace(dn)+")")
		}
		if len(members) > 0 {
			userFilter = "(|" + strings.Join(members, "") + ")"
		}
	}
	settings := [][]string{
		{"server", s.vaultURL},
		{"directory", "0"},
		{"ldap.ssl", "true"},
		{"ldap.sslAllowUnauthorized", "false"},
		{"ldap.hostname", s.ldapHost},
		{"ldap.port", "636"},
		{"ldap.ad", "true"},
		{"ldap.rootPath", s.baseDN},
		{"ldap.username", bind},
		{"ldap.password", s.password},
		{"sync.users", "true"},
		{"sync.groups", "true"},
		{"sync.removeDisabled", "true"},
		{"sync.overwriteExisting", "false"},
		{"sync.largeImport", "true"},
		{"sync.groupFilter", groupFilter},
		{"sync.userFilter", userFilter},
		{"sync.useEmailPrefixSuffix", strconv.FormatBool(s.mailDomain != "")},
		{"sync.emailPrefixAttribute", "sAMAccountName"},
		{"sync.emailSuffix", "@" + s.mailDomain},
	}
	for _, pair := range settings {
		if _, err := runBwdc(ctx, env, "config", pair[0], pair[1]); err != nil {
			return fmt.Errorf("bwdc config %s: %w", pair[0], err)
		}
	}
	return nil
}

func runBwdc(ctx context.Context, env apply.Env, args ...string) (string, error) {
	full := append([]string{"--setenv=HOME=" + bwdcHome, "--setenv=NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
		"--pipe", "--wait", "--collect", "--quiet", "--", env.Path(bwdcBinary)}, args...)
	if env.Root != "" {
		return env.Run.Run(ctx, env.Path(bwdcBinary), args...)
	}
	return env.Run.Run(ctx, "systemd-run", full...)
}
