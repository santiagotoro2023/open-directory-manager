package apply

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Logon hours: when a person or a group may sign in at this machine.
//
// The rules are written to a file the agent's own PAM helper reads in the
// account phase of every interactive sign-in — the screen, SSH, remote
// desktop — through one line in common-account. Not pam_time: its users
// field cannot name a directory group, and a department is exactly what a
// rule here names. Not sudo or cron either: the helper looks at which
// service is asking and answers yes to anything that is not a sign-in, so a
// person already at the machine keeps their sudo, and a job keeps running.
//
// A rule with sign_out puts a timer on the machine that signs open sessions
// out when their window closes, which is the "force logoff" half of Active
// Directory's setting.

const (
	logonHoursPath  = "/etc/odm/logon-hours.json"
	logonHoursLine  = "account required pam_exec.so seteuid quiet stdout /usr/sbin/odm-agent logon-hours"
	logonHoursTimer = "/etc/systemd/system/odm-logon-hours.timer"
	logonHoursUnit  = "/etc/systemd/system/odm-logon-hours.service"
)

// LogonHoursFile is what the helper reads: the rules, as the policy gave
// them, plus nothing it has to work out for itself.
type LogonHoursFile struct {
	Rules []policy.LogonHoursRule `json:"rules"`
}

func applyLogonHours(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.LogonHours) == 0 {
		// Taken back: the PAM line goes, and with it the file it reads. A
		// stale file with a missing line would restrict nobody; a stale line
		// with a missing file must let everyone in, which the helper does.
		if err := env.ReplaceBlock(pamAccountPath, "", 0o644); err != nil {
			return []policy.Result{policy.Fail("logon_hours", err)}
		}
		return nil
	}
	rules := make([]policy.LogonHoursRule, 0, len(s.LogonHours))
	for _, rule := range s.LogonHours {
		if rule.Principal == "" || len(rule.Days) == 0 {
			continue
		}
		rules = append(rules, rule)
	}
	sort.SliceStable(rules, func(i, j int) bool { return rules[i].Principal < rules[j].Principal })

	body, err := json.MarshalIndent(LogonHoursFile{Rules: rules}, "", "  ")
	if err != nil {
		return []policy.Result{policy.Fail("logon_hours", err)}
	}
	// World-readable: the helper runs as root through pam_exec, but the
	// file holds nothing secret — who may sign in when is what the person
	// is told anyway.
	if err := env.WriteFile(logonHoursPath, string(body)+"\n", 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("logon_hours", err)}
	}

	managed := "# " + strings.TrimSuffix(strings.TrimPrefix(Header, "# "), "\n") + "\n"
	if err := env.ReplaceBlock(pamAccountPath, managed+logonHoursLine+"\n", 0o644); err != nil {
		return []policy.Result{policy.Fail("logon_hours", err)}
	}

	// The timer, for rules that end a session rather than only refuse a new
	// one. Written only when a rule asks, and pruned when none does.
	signOut := false
	for _, rule := range rules {
		if rule.SignOut {
			signOut = true
		}
	}
	results := []policy.Result{}
	if signOut {
		unit := Header +
			"[Unit]\nDescription=Open Directory Manager logon hours\n\n" +
			"[Service]\nType=oneshot\nExecStart=/usr/sbin/odm-agent logon-hours --sweep\n"
		timer := Header +
			"[Unit]\nDescription=Open Directory Manager logon hours, every minute\n\n" +
			"[Timer]\nOnBootSec=1min\nOnUnitActiveSec=1min\nAccuracySec=10s\n\n" +
			"[Install]\nWantedBy=timers.target\n"
		if err := env.WriteFile(logonHoursUnit, unit, 0o644, "root", "root"); err != nil {
			return append(results, policy.Fail("logon_hours:sign_out", err))
		}
		if err := env.WriteFile(logonHoursTimer, timer, 0o644, "root", "root"); err != nil {
			return append(results, policy.Fail("logon_hours:sign_out", err))
		}
		if env.Run != nil {
			results = append(results, runAll(ctx, env, "logon_hours:sign_out",
				[]string{"systemctl", "daemon-reload"},
				[]string{"systemctl", "enable", "--now", "odm-logon-hours.timer"}))
		}
	} else if _, statErr := os.Stat(env.Path(logonHoursTimer)); statErr == nil && env.Run != nil {
		// Still there from a rule that used to ask; stopped now, and the
		// prune removes the files.
		_, _ = env.Run.Run(ctx, "systemctl", "disable", "--now", "odm-logon-hours.timer")
	}
	results = append(results, policy.Ok("logon_hours"))
	return results
}
