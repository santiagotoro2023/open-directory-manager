package join

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const (
	Krb5ConfPath    = "/etc/krb5.conf"
	SssdConfPath    = "/etc/sssd/sssd.conf"
	KeytabPath      = "/etc/krb5.keytab"
	NsswitchPath    = "/etc/nsswitch.conf"
	SmbConfPath     = "/etc/samba/smb.conf"
	AgentConfigPath = "/etc/odm/agent.json"
	CACertPath      = "/etc/odm/tls/api-ca.pem"
	PamMkHomeDir    = "/usr/share/pam-configs/odm-mkhomedir"

	managed = "# Managed by Open Directory Manager. Local edits are overwritten.\n"
)

// WriteSmbConf makes this machine a domain member as far as Samba's tools are
// concerned.
//
// Debian ships smb.conf saying "server role = standalone server" and
// "workgroup = WORKGROUP", and net ads join reads it before it does anything:
//
//	Invalid configuration.  Exiting....
//	Host is not configured as a member server.
//
// Nothing wrote this file, so no client could ever join. realmd writes the
// same three settings for the same reason.
func WriteSmbConf(options Options, workgroup string, env Env) error {
	body := managed + fmt.Sprintf(`[global]
    workgroup = %s
    realm = %s
    security = ADS
    kerberos method = secrets and keytab
    dedicated keytab file = %s
    winbind refresh tickets = yes
    client signing = mandatory
    client ipc signing = mandatory

# A file server adds its shares from here; joining leaves that alone.
include = /etc/samba/odm-shares.conf
`, workgroup, options.Realm, KeytabPath)

	if err := env.Backup(SmbConfPath); err != nil {
		return err
	}
	// The include must exist or Samba complains on every command.
	if err := env.WriteFileIfMissing("/etc/samba/odm-shares.conf", managed, 0o644); err != nil {
		return err
	}
	return env.WriteFile(SmbConfPath, body, 0o644)
}

// Workgroup is the domain's NetBIOS name, which is not always the first label
// of the realm — a domain called corp.example.org can be EXAMPLE. The
// controller knows; ask it, and fall back to the realm's first label.
func Workgroup(ctx context.Context, options Options, controller string, env Env) string {
	fallback := strings.ToUpper(strings.SplitN(options.Realm, ".", 2)[0])
	if env.Run == nil || controller == "" {
		return fallback
	}
	out, err := env.Run.Run(ctx, "net", "ads", "lookup", "-S", controller)
	if err != nil {
		return fallback
	}
	for _, line := range strings.Split(out, "\n") {
		name, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(name), "Pre-Win2k Domain") {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				return strings.ToUpper(trimmed)
			}
		}
	}
	return fallback
}

// WriteKrb5Conf points Kerberos at the realm. Both front ends produce this
// same file.
func WriteKrb5Conf(options Options, env Env) error {
	body := managed + fmt.Sprintf(`[libdefaults]
    default_realm = %s
    dns_lookup_realm = false
    dns_lookup_kdc = true
    rdns = false
    kdc_timesync = 1
    ticket_lifetime = 24h
    renew_lifetime = 7d
    forwardable = true

[realms]
    %s = {
        default_domain = %s
    }

[domain_realm]
    .%s = %s
    %s = %s
`, options.Realm, options.Realm, options.Domain,
		options.Domain, options.Realm, options.Domain, options.Realm)

	if err := env.Backup(Krb5ConfPath); err != nil {
		return err
	}
	return env.WriteFile(Krb5ConfPath, body, 0o644)
}

// WriteSssdConf configures identity and authentication against the domain.
func WriteSssdConf(options Options, env Env) error {
	body := managed + fmt.Sprintf(`[sssd]
domains = %s
config_file_version = 2
services = nss, pam, ifp

[domain/%s]
id_provider = ad
auth_provider = ad
access_provider = simple
chpass_provider = ad
sudo_provider = none

ad_domain = %s
krb5_realm = %s
krb5_store_password_if_offline = true
cache_credentials = true

# Names as the domain knows them, without the realm suffix.
use_fully_qualified_names = false
fallback_homedir = /home/%%u
default_shell = /bin/bash
ldap_id_mapping = true

# The machine authenticates with its own keytab.
ldap_sasl_mech = GSSAPI
ldap_sasl_authid = %s$
`, options.Domain, options.Domain, options.Domain, options.Realm,
		strings.ToUpper(shortName(options.Hostname)))

	if err := env.Backup(SssdConfPath); err != nil {
		return err
	}
	// sssd refuses to start if this file is readable by anyone else.
	return env.WriteFile(SssdConfPath, body, 0o600)
}

// WriteKeytab installs the machine's own Kerberos keys.
func WriteKeytab(env Env, keytab []byte) error {
	if len(keytab) == 0 {
		return fmt.Errorf("the control plane returned an empty keytab")
	}
	if err := env.Backup(KeytabPath); err != nil {
		return err
	}
	full := env.Path(KeytabPath)
	if err := os.MkdirAll(dir(full), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(full, keytab, 0o600); err != nil {
		return err
	}
	return os.Chmod(full, 0o600)
}

// ConfigureNameService makes domain identities resolve, and creates home
// directories on first login.
func ConfigureNameService(ctx context.Context, options Options, env Env) error {
	if err := updateNsswitch(env); err != nil {
		return err
	}
	profile := managed + `Name: Create home directory on login
Default: yes
Priority: 900
Session-Type: Additional
Session:
	required			pam_mkhomedir.so umask=0077 skel=/etc/skel
`
	if err := env.WriteFile(PamMkHomeDir, profile, 0o644); err != nil {
		return err
	}
	if options.DryRun || env.Run == nil {
		return nil
	}
	if _, err := env.Run.Run(ctx, "pam-auth-update", "--package", "--enable", "odm-mkhomedir"); err != nil {
		// Not fatal: the machine is joined, home directories simply are not
		// created automatically.
		return nil
	}
	return nil
}

func updateNsswitch(env Env) error {
	body, err := os.ReadFile(env.Path(NsswitchPath))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	lines := strings.Split(string(body), "\n")
	for index, line := range lines {
		for _, database := range []string{"passwd:", "group:", "shadow:"} {
			if strings.HasPrefix(strings.TrimSpace(line), database) &&
				!strings.Contains(line, " sss") {
				lines[index] = strings.TrimRight(line, " \t") + " sss"
			}
		}
	}
	if err := env.Backup(NsswitchPath); err != nil {
		return err
	}
	return env.WriteFile(NsswitchPath, strings.Join(lines, "\n"), 0o644)
}

// AgentConfig is what the policy agent reads.
type AgentConfig struct {
	APIURL           string `json:"api_url"`
	ServicePrincipal string `json:"service_principal"`
	Keytab           string `json:"keytab"`
	Realm            string `json:"realm"`
	Krb5Conf         string `json:"krb5_conf"`
	CACert           string `json:"ca_cert,omitempty"`
	RefreshMinutes   int    `json:"refresh_minutes"`
}

// InstallAgent writes the agent configuration and enables its service.
func InstallAgent(ctx context.Context, options Options, env Env) error {
	host := strings.TrimPrefix(options.APIURL, "https://")
	host = strings.SplitN(host, "/", 2)[0]
	host = strings.SplitN(host, ":", 2)[0]

	// Copy the certificate in rather than pointing at wherever the operator
	// happened to leave it: /tmp is cleaned, a home directory may not be
	// readable by a service, and the agent reads this on every refresh.
	caCert := options.CACert
	if caCert != "" && caCert != CACertPath && caCert != env.Path(CACertPath) {
		// Not fatal: the machine is joined by now, and a join that fails at
		// the last step over a file that moved is worse than an agent that
		// says it cannot verify the console.
		if body, err := os.ReadFile(caCert); err == nil {
			if err := env.WriteFile(CACertPath, string(body), 0o644); err != nil {
				return err
			}
			caCert = CACertPath
		}
	}

	config := AgentConfig{
		APIURL:           options.APIURL,
		ServicePrincipal: "HTTP/" + host,
		Keytab:           KeytabPath,
		Realm:            options.Realm,
		Krb5Conf:         Krb5ConfPath,
		CACert:           caCert,
		RefreshMinutes:   15,
	}
	body, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	if err := env.WriteFile(AgentConfigPath, string(body)+"\n", 0o640); err != nil {
		return err
	}
	if options.DryRun || env.Run == nil {
		return nil
	}
	if _, err := env.Run.Run(ctx, "systemctl", "enable", "--now", "odm-agent"); err != nil {
		return fmt.Errorf("the agent service did not start: %w", err)
	}
	return nil
}

func shortName(hostname string) string {
	return strings.SplitN(hostname, ".", 2)[0]
}

func dir(path string) string {
	index := strings.LastIndex(path, "/")
	if index <= 0 {
		return "/"
	}
	return path[:index]
}
