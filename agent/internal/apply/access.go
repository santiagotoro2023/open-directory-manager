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

const trustAnchorDir = "/usr/local/share/ca-certificates"

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
		path := trustAnchorDir + "/odm-" + strings.ReplaceAll(anchor.Name, ".", "-") + ".crt"
		if err := env.WriteFile(path, body, 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		installed = true
		results = append(results, policy.Ok(setting))
	}

	if installed {
		results = append(results, runAll(ctx, env, "trusted_certificates:refresh",
			[]string{"update-ca-certificates"}))
	}
	return results
}
