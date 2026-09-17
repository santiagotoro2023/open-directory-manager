package apply

import (
	"context"
	"fmt"
	"os"
	"strings"

	"odm.example.org/agent/internal/policy"
)

const (
	sudoersDir     = "/etc/sudoers.d"
	sudoersStaging = "/etc/odm/sudoers-candidate"
	accessConf     = "/etc/security/access.conf"
	pamAccountPath = "/etc/pam.d/common-account"
	sshdDropIn     = "/etc/ssh/sshd_config.d/50-odm.conf"
)

// alwaysAllowed can never be locked out by policy. An HBAC rule set that
// excludes root would strand the machine, and no policy mistake should cost
// an operator access to a server.
var alwaysAllowed = []string{"root", "(sudo)"}

// Sudo command scope (CLAUDE.md §3.5).
//
// Rules are written per GPO setting into /etc/sudoers.d and validated with
// visudo before they are installed — an unparsable sudoers file breaks sudo
// for everyone on the machine.
func applySudo(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	results := make([]policy.Result, 0, len(s.SudoRules))
	for _, rule := range s.SudoRules {
		setting := "sudo:" + rule.Name
		runAs := rule.RunAs
		if runAs == "" {
			runAs = "ALL"
		}
		tag := ""
		if rule.NoPasswd {
			tag = "NOPASSWD: "
		}
		body := Header + fmt.Sprintf(
			"%s ALL=(%s) %s%s\n",
			strings.Join(rule.Users, ","), runAs, tag, strings.Join(rule.Commands, ", "),
		)
		// cron.d-style naming rules apply to sudoers.d too: no dots.
		path := sudoersDir + "/odm-" + strings.ReplaceAll(rule.Name, ".", "-")

		// Validate a candidate outside sudoers.d first: an unparsable file
		// in that directory breaks sudo for everyone on the machine.
		if err := env.WriteFile(sudoersStaging, body, 0o440, "root", "root"); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		if env.Run != nil {
			if _, err := env.Run.Run(ctx, "visudo", "-cf", env.Path(sudoersStaging)); err != nil {
				results = append(results, policy.Fail(setting, err))
				continue
			}
		}
		if err := env.WriteFile(path, body, 0o440, "root", "root"); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		results = append(results, policy.Ok(setting))
	}
	return results
}

// Host-based access control (CLAUDE.md §3.5): who may open a session on this
// machine — locally, over SSH, or over RDP — and through which service. Deny
// overrides allow.
//
// Every service is gated with pam_access reading its own file, and each
// service's PAM stack is told which file to read. That is what gives real
// per-service control: pam_access matches users and groups with the "or"
// an operator expects, and the PAM stack is what knows whether this is ssh,
// a console login, or a remote desktop session.
//
// sshd's own AllowUsers and AllowGroups are deliberately not used for allow
// rules. sshd requires a user to match *both* when both are present, so an
// allow rule naming a group locked that group out — the group went in
// AllowGroups, root went in AllowUsers, and nobody satisfied both. Denies
// still get an sshd drop-in, because those are refused before PAM runs and
// carry no such trap.
func applyHbacRules(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.HbacRules) == 0 {
		return nil
	}

	// Which PAM service each kind of session arrives through.
	services := map[string][]string{
		"local": {"login", "gdm-password", "sddm", "lightdm"},
		"ssh":   {"sshd"},
		"rdp":   {"xrdp-sesman"},
	}

	var results []policy.Result
	var denySSHUsers, denySSHGroups []string

	for _, service := range []string{"local", "ssh", "rdp"} {
		var lines []string
		var allows int

		// pam_access takes the first matching rule, so every deny comes
		// before any allow.
		for _, pass := range []string{"deny", "allow"} {
			for _, right := range s.HbacRules {
				if right.Access != pass {
					continue
				}
				if right.Service != "all" && right.Service != service {
					continue
				}
				sign := "+"
				if pass == "deny" {
					sign = "-"
				}
				lines = append(lines, fmt.Sprintf("%s:%s:ALL", sign, accessName(right.Principal)))
				if pass == "allow" {
					allows++
				}
				if service == "ssh" && pass == "deny" {
					if group, name := sshName(right.Principal); group {
						denySSHGroups = append(denySSHGroups, name)
					} else {
						denySSHUsers = append(denySSHUsers, name)
					}
				}
			}
		}

		// An allow list only means anything with a closing deny — but root
		// and the local administrators are never locked out by policy.
		if allows > 0 {
			lines = append(lines, "+:"+strings.Join(alwaysAllowed, " ")+":ALL")
			lines = append(lines, "-:ALL:ALL")
		}

		path := accessFileFor(service)
		if len(lines) == 0 {
			// Nothing said about this service means nothing gated for it.
			lines = []string{"# No rules for " + service + "."}
		}
		if err := env.WriteFile(path, Header+strings.Join(lines, "\n")+"\n", 0o644,
			"root", "root"); err != nil {
			results = append(results, policy.Fail("hbac:"+service, err))
			continue
		}
		for _, pam := range services[service] {
			target := "/etc/pam.d/" + pam
			if _, err := os.Stat(env.Path(target)); err != nil {
				// A machine without a desktop has no gdm stack to gate.
				continue
			}
			if err := env.ReplaceBlock(
				target, "account required pam_access.so accessfile="+path+"\n", 0o644,
			); err != nil {
				results = append(results, policy.Fail("hbac:"+service, err))
			}
		}
		results = append(results, policy.Ok("hbac:"+service))
	}

	// Denied principals are refused before PAM runs. Deny directives are
	// independent of each other, so naming both users and groups is safe.
	var sshd strings.Builder
	sshd.WriteString(Header)
	for _, directive := range []struct {
		keyword string
		values  []string
	}{
		{"DenyUsers", denySSHUsers},
		{"DenyGroups", denySSHGroups},
	} {
		if len(directive.values) > 0 {
			sshd.WriteString(directive.keyword + " " + strings.Join(directive.values, " ") + "\n")
		}
	}
	if err := env.WriteFile(sshdDropIn, sshd.String(), 0o644, "root", "root"); err != nil {
		results = append(results, policy.Fail("hbac:ssh", err))
		return results
	}
	results = append(results, runAll(ctx, env, "hbac:sshd",
		[]string{"sshd", "-t"},
		[]string{"systemctl", "reload-or-restart", "ssh"},
	))
	return results
}

// accessFileFor is where one service's rules live.
func accessFileFor(service string) string {
	return "/etc/security/odm-access-" + service + ".conf"
}

// accessName is how pam_access spells a principal. A group is written in
// parentheses; ODM writes it with a leading % the way sudo and sshd do.
func accessName(principal string) string {
	if group, name := sshName(principal); group {
		return "(" + name + ")"
	}
	return principal
}

func sshName(principal string) (bool, string) {
	if strings.HasPrefix(principal, "%") {
		return true, principal[1:]
	}
	return false, principal
}

func withRoot(values []string, keep string) []string {
	if len(values) == 0 {
		return nil
	}
	return append(values, keep)
}

const (
	trustAnchorDir = "/usr/local/share/ca-certificates"
	// Where Firefox on Linux looks for certificates its Install policy names.
	// Firefox does not read the system store on Linux — ImportEnterpriseRoots
	// is Windows and macOS only (Mozilla bug 1600509) — so every anchor is
	// written a second time, here, and named in the Firefox policy.
	mozillaCertDir = "/usr/lib/mozilla/certificates"
)

// trustAnchorFile is the file name an anchor is kept under, in both places.
func trustAnchorFile(name string) string {
	return "odm-" + strings.ReplaceAll(name, ".", "-") + ".crt"
}

// Chromium, Chrome, Edge and Brave on Linux keep their trust in NSS, in a
// database per person (~/.pki/nssdb), and read neither the system store nor
// Firefox's directory. The one documented way in is certutil against that
// database, as that person — so it is done at each sign-in by the PAM hook
// (before any browser starts), and once, at apply time, for everybody who
// already has a home on the machine. Anchors ODM added carry an "odm:"
// nickname; one no longer in policy is removed by the same script.
const nssdbHook = "/etc/odm/scripts/logon/odm-trust-nssdb"

// nssdbScript is that script. $1 is the account to act for (the PAM hook
// passes none and it reads $PAM_USER); the anchors are listed in the file
// the trust applier writes beside it.
const nssdbScript = `#!/bin/sh
` + Header + `# Puts the domain's trust anchors into one person's NSS database, which is
# where Chromium and Chrome on Linux look. Run by PAM at sign-in, and by the
# agent for existing homes.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
user="${1:-$PAM_USER}"
[ -n "$user" ] || exit 0
[ "$(id -u "$user" 2>/dev/null || echo 0)" -ge 1000 ] || exit 0
command -v certutil >/dev/null 2>&1 || exit 0
home=$(getent passwd "$user" | cut -d: -f6)
[ -n "$home" ] && [ -d "$home" ] || exit 0
db="$home/.pki/nssdb"
wanted="` + trustAnchorDir + `/odm-nssdb.list"
as_user() { runuser -u "$user" -- "$@"; }
if [ ! -f "$db/cert9.db" ]; then
  as_user mkdir -p "$db" || exit 0
  as_user certutil -N -d "sql:$db" --empty-password >/dev/null 2>&1 || exit 0
fi
# Anchors ODM added before and policy no longer names.
as_user certutil -L -d "sql:$db" 2>/dev/null | awk '/^odm:/ { sub(/ +[a-zA-Z,]*$/, ""); print }' |
while IFS= read -r nick; do
  [ -n "$nick" ] || continue
  if ! grep -qxF "$nick" "$wanted" 2>/dev/null; then
    as_user certutil -D -d "sql:$db" -n "$nick" >/dev/null 2>&1 || true
  fi
done
[ -f "$wanted" ] || exit 0
while IFS= read -r nick; do
  [ -n "$nick" ] || continue
  file="` + trustAnchorDir + `/${nick#odm:}.crt"
  [ -f "$file" ] || continue
  as_user certutil -D -d "sql:$db" -n "$nick" >/dev/null 2>&1 || true
  as_user certutil -A -d "sql:$db" -t "C,," -n "$nick" -i "$file" >/dev/null 2>&1 || true
done < "$wanted"
exit 0
`

// trustNSSDatabases writes the script and its anchor list, makes sure
// certutil exists, and runs the script for every home already on the
// machine so the change does not wait for the next sign-in.
func trustNSSDatabases(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	var results []policy.Result
	var names []string
	for _, anchor := range s.TrustedCerts {
		names = append(names, "odm:"+strings.TrimSuffix(trustAnchorFile(anchor.Name), ".crt"))
	}
	if err := env.WriteFile(trustAnchorDir+"/odm-nssdb.list", strings.Join(names, "\n")+"\n", 0o644, "root", "root"); err != nil {
		return append(results, policy.Fail("trusted_certificates:browsers", err))
	}
	if err := env.WriteFile(nssdbHook, nssdbScript, 0o755, "root", "root"); err != nil {
		return append(results, policy.Fail("trusted_certificates:browsers", err))
	}
	if env.Run == nil {
		return results
	}
	if _, err := os.Stat(env.Path("/usr/bin/certutil")); err != nil && env.Root == "" {
		if out, err := Unsandboxed(ctx, env, "apt-get", "-y", "-o", "DPkg::Lock::Timeout=600", "install", "libnss3-tools"); err != nil {
			return append(results, policy.Result{
				Setting: "trusted_certificates:browsers", Status: "failed",
				Reason: "installing libnss3-tools (certutil): " + strings.TrimSpace(lastLine(out)),
			})
		}
	}
	// Everyone with a home on this machine, not only whoever signs in next.
	entries, _ := os.ReadDir(env.Path("/home"))
	done := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := env.Run.Run(ctx, nssdbHook, entry.Name()); err == nil {
			done++
		}
	}
	return append(results, policy.Result{
		Setting: "trusted_certificates:browsers", Status: "success",
		Reason: fmt.Sprintf("Chromium trust written for %d home(s); the rest at sign-in", done),
	})
}

// Trust anchors (CLAUDE.md §4): certificates the domain's own authority
// issues are only useful once machines trust the root that signed them.
// Debian reads anchors from /usr/local/share/ca-certificates and rebuilds
// the bundle with update-ca-certificates.
func applyTrustedCertificates(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.TrustedCerts) == 0 {
		return nil
	}
	results := make([]policy.Result, 0, len(s.TrustedCerts)+1)
	installed := false

	for _, anchor := range s.TrustedCerts {
		setting := "trusted_certificates:" + anchor.Name
		if !strings.Contains(anchor.CertificatePEM, "-----BEGIN CERTIFICATE-----") {
			results = append(results, policy.Skip(setting, "not a PEM certificate"))
			continue
		}
		body := anchor.CertificatePEM
		if !strings.HasSuffix(body, "\n") {
			body += "\n"
		}
		// update-ca-certificates only considers files ending in .crt.
		path := trustAnchorDir + "/" + trustAnchorFile(anchor.Name)
		if err := env.WriteFile(path, body, 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		if err := env.WriteFile(mozillaCertDir+"/"+trustAnchorFile(anchor.Name), body, 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		installed = true
		results = append(results, policy.Ok(setting))
	}

	if installed {
		results = append(results, runAll(ctx, env, "trusted_certificates:refresh",
			[]string{"update-ca-certificates"}))
		results = append(results, trustNSSDatabases(ctx, s, env)...)
	}
	return results
}
