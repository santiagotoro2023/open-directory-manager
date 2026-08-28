package apply

import (
	"context"
	"fmt"
	"strings"

	"odm.example.org/agent/internal/policy"
)

const (
	sudoersDir   = "/etc/sudoers.d"
	accessConf   = "/etc/security/access.conf"
	pamAccountPath = "/etc/pam.d/common-account"
	sshdDropIn   = "/etc/ssh/sshd_config.d/50-odm.conf"
)

// alwaysAllowed can never be locked out by policy. Writing a logon-rights
// policy that excludes root would strand the machine, and no policy mistake
// should cost an operator physical access to a server.
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

		if err := env.WriteFile(path+".tmp-check", body, 0o440, "root", "root"); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		if env.Run != nil {
			if _, err := env.Run.Run(ctx, "visudo", "-cf", env.Path(path+".tmp-check")); err != nil {
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

// Logon rights (CLAUDE.md §3.5): who may log on locally, over SSH, or over
// RDP, on this machine. Deny overrides allow, as in AD.
//
// Local and RDP sessions are gated with pam_access; SSH additionally gets an
// sshd drop-in so denied principals are refused before PAM runs.
func applyLogonRights(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.LogonRights) == 0 {
		return nil
	}

	var lines []string
	var allowAll []string
	var denySSHUsers, denySSHGroups, allowSSHUsers, allowSSHGroups []string

	// pam_access takes the first matching rule, so every deny is written
	// before any allow.
	for _, right := range s.LogonRights {
		if right.Access != "deny" {
			continue
		}
		lines = append(lines, fmt.Sprintf("-:%s:ALL", right.Principal))
		if right.Service == "ssh" || right.Service == "all" {
			if group, name := sshName(right.Principal); group {
				denySSHGroups = append(denySSHGroups, name)
			} else {
				denySSHUsers = append(denySSHUsers, name)
			}
		}
	}
	for _, right := range s.LogonRights {
		if right.Access == "deny" {
			continue
		}
		lines = append(lines, fmt.Sprintf("+:%s:ALL", right.Principal))
		allowAll = append(allowAll, right.Principal)
		if right.Service == "ssh" || right.Service == "all" {
			if group, name := sshName(right.Principal); group {
				allowSSHGroups = append(allowSSHGroups, name)
			} else {
				allowSSHUsers = append(allowSSHUsers, name)
			}
		}
	}

	results := []policy.Result{}
	if len(allowAll) > 0 {
		// An allow list is only meaningful with a closing deny, but root and
		// local administrators are always kept.
		lines = append(lines, "+:"+strings.Join(alwaysAllowed, " ")+":ALL")
		lines = append(lines, "-:ALL:ALL")
	}

	if err := env.ReplaceBlock(accessConf, strings.Join(lines, "\n")+"\n", 0o644); err != nil {
		results = append(results, policy.Fail("logon_rights:access", err))
	} else if err := env.ReplaceBlock(
		pamAccountPath, "account required pam_access.so\n", 0o644,
	); err != nil {
		results = append(results, policy.Fail("logon_rights:access", err))
	} else {
		results = append(results, policy.Ok("logon_rights:access"))
	}

	// sshd keeps users and groups in separate directives, and an Allow*
	// directive is itself a deny-by-default for everyone else — so the local
	// administrators are always added to it.
	var sshd strings.Builder
	sshd.WriteString(Header)
	for _, directive := range []struct {
		keyword string
		values  []string
	}{
		{"DenyUsers", denySSHUsers},
		{"DenyGroups", denySSHGroups},
		{"AllowUsers", withRoot(allowSSHUsers, "root")},
		{"AllowGroups", withRoot(allowSSHGroups, "sudo")},
	} {
		if len(directive.values) > 0 {
			sshd.WriteString(directive.keyword + " " + strings.Join(directive.values, " ") + "\n")
		}
	}
	if err := env.WriteFile(sshdDropIn, sshd.String(), 0o644, "root", "root"); err != nil {
		results = append(results, policy.Fail("logon_rights:ssh", err))
		return results
	}
	results = append(results, runAll(ctx, env, "logon_rights:ssh",
		[]string{"sshd", "-t"},
		[]string{"systemctl", "reload-or-restart", "ssh"},
	))
	return results
}

// sshName reports whether the principal is a group, and its bare name;
// pam_access marks groups with a leading %, sshd does not.
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
