package apply

import (
	"context"
	"fmt"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// File deployment (CLAUDE.md §3.5).
func applyFiles(_ context.Context, s policy.Settings, env Env) []policy.Result {
	results := make([]policy.Result, 0, len(s.Files))
	for _, file := range s.Files {
		setting := "files:" + file.Path
		if err := env.WriteFile(
			file.Path, file.Content, ParseMode(file.Mode, 0o644), file.Owner, file.Group,
		); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		results = append(results, policy.Ok(setting))
	}
	return results
}

const (
	scriptDir      = "/etc/odm/scripts"
	scriptUnitPath = "/etc/systemd/system/odm-scripts.service"
	pamHookPath    = "/usr/lib/odm/pam-session-hook"
	pamSessionPath = "/etc/pam.d/common-session"
)

// Startup/shutdown scripts run from one systemd unit; logon/logoff run from a
// pam_exec hook, so they cover console, SSH and display-manager sessions
// alike rather than only shell logins.
func applyScripts(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	var results []policy.Result
	triggers := map[string]bool{}

	for _, script := range s.Scripts {
		setting := "scripts:" + script.Trigger + "/" + script.Name
		interpreter := script.Interpreter
		if interpreter == "" {
			interpreter = "/bin/sh"
		}
		body := "#!" + interpreter + "\n" + Header + script.Content
		path := fmt.Sprintf("%s/%s/%s", scriptDir, script.Trigger, script.Name)
		if err := env.WriteFile(path, body, 0o700, "root", "root"); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		triggers[script.Trigger] = true
		results = append(results, policy.Ok(setting))
	}

	if triggers["startup"] || triggers["shutdown"] {
		unit := Header + `[Unit]
Description=Open Directory Manager startup and shutdown scripts
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/run-parts --report ` + scriptDir + `/startup
ExecStop=/bin/run-parts --report ` + scriptDir + `/shutdown

[Install]
WantedBy=multi-user.target
`
		if err := env.WriteFile(scriptUnitPath, unit, 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail("scripts:unit", err))
		} else {
			results = append(results, runAll(ctx, env, "scripts:unit",
				[]string{"systemctl", "daemon-reload"},
				[]string{"systemctl", "enable", "odm-scripts.service"},
			))
		}
	}

	results = append(results, installSessionHook(env))
	return results
}

// repairHome is part of the PAM hook rather than the agent's apply loop: it
// has to run before the desktop starts, not fifteen minutes later.
//
// A home directory left behind by an earlier incarnation of an account — a
// restored user, or one deleted and recreated by hand, gets a new SID and so a
// new uid — belongs to nobody. Nothing else on the machine repairs it, and the
// symptom is not a permissions error anybody would connect to it: the desktop
// comes up with no background, applications that hang for minutes waiting to
// write a cache, and a file manager that refuses to open the person's own home.
// Only an owner that no account has is repaired; an ownership somebody chose
// is somebody's decision.
const repairHome = `odm_repair_home() {
  [ -n "$PAM_USER" ] || return 0
  home=$(getent passwd "$PAM_USER" | cut -d: -f6)
  uid=$(id -u "$PAM_USER" 2>/dev/null) || return 0
  [ -n "$home" ] && [ -d "$home" ] && [ -n "$uid" ] || return 0
  owner=$(stat -c %u "$home" 2>/dev/null) || return 0
  [ "$owner" = "$uid" ] && return 0
  getent passwd "$owner" >/dev/null 2>&1 && return 0
  chown -R "$uid:$(id -g "$PAM_USER")" "$home" 2>/dev/null || true
}

`

// installSessionHook wires the agent into PAM sessions. It always runs, not
// only when logon scripts exist, because it is also how a user's own policy
// (per-user drive maps, desktop background) reaches the machine at login.
//
// The user apply is backgrounded behind a timeout: a slow or unreachable
// control plane must never hold up somebody logging in.
func installSessionHook(env Env) policy.Result {
	hook := "#!/bin/sh\n" + Header + repairHome + `case "$PAM_TYPE" in
  open_session)
    odm_repair_home
    [ -d ` + scriptDir + `/logon ] && /bin/run-parts --report ` + scriptDir + `/logon
    [ -n "$PAM_USER" ] && timeout 60 /usr/sbin/odm-agent apply --user "$PAM_USER" >/dev/null 2>&1 &
    ;;
  close_session)
    [ -d ` + scriptDir + `/logoff ] && /bin/run-parts --report ` + scriptDir + `/logoff
    ;;
esac
exit 0
`
	if err := env.WriteFile(pamHookPath, hook, 0o755, "root", "root"); err != nil {
		return policy.Fail("scripts:pam-hook", err)
	}
	if err := env.ReplaceBlock(
		pamSessionPath, "session optional pam_exec.so "+pamHookPath+"\n", 0o644,
	); err != nil {
		return policy.Fail("scripts:pam-hook", err)
	}
	return policy.Ok("scripts:pam-hook")
}

// systemd unit state (CLAUDE.md §3.5).
func applySystemdUnits(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.SystemdUnits) == 0 {
		return nil
	}
	results := make([]policy.Result, 0, len(s.SystemdUnits))
	for _, unit := range s.SystemdUnits {
		setting := "systemd:" + unit.Unit
		var commands [][]string
		switch unit.State {
		case "enabled":
			commands = [][]string{{"systemctl", "unmask", unit.Unit},
				{"systemctl", "enable", "--now", unit.Unit}}
		case "disabled":
			commands = [][]string{{"systemctl", "disable", "--now", unit.Unit}}
		case "masked":
			commands = [][]string{{"systemctl", "mask", "--now", unit.Unit}}
		case "started":
			commands = [][]string{{"systemctl", "start", unit.Unit}}
		case "stopped":
			commands = [][]string{{"systemctl", "stop", unit.Unit}}
		default:
			results = append(results, policy.Skip(setting, "unknown state "+unit.State))
			continue
		}
		results = append(results, runAll(ctx, env, setting, commands...))
	}
	return results
}

// Central cron entries (CLAUDE.md §3.5).
func applyCron(_ context.Context, s policy.Settings, env Env) []policy.Result {
	results := make([]policy.Result, 0, len(s.Cron))
	for _, job := range s.Cron {
		setting := "cron:" + job.Name
		user := job.User
		if user == "" {
			user = "root"
		}
		body := Header + "SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin\n" +
			fmt.Sprintf("%s %s %s\n", job.Schedule, user, job.Command)
		// cron.d ignores files whose names contain a dot.
		path := "/etc/cron.d/odm-" + strings.ReplaceAll(job.Name, ".", "-")
		if err := env.WriteFile(path, body, 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		results = append(results, policy.Ok(setting))
	}
	return results
}

const (
	firewallPath = "/etc/odm/firewall.nft"
	firewallUnit = "/etc/systemd/system/odm-firewall.service"
)

// Basic firewall rules (CLAUDE.md §3.5).
//
// Rules go in a dedicated `inet odm` nftables table that is flushed and
// rebuilt as a unit, so ODM never disturbs rules another tool owns.
func applyFirewall(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.Firewall) == 0 {
		return nil
	}
	var input, output strings.Builder
	for _, rule := range s.Firewall {
		line := renderNftRule(rule)
		if rule.Direction == "out" {
			output.WriteString("    " + line + "\n")
		} else {
			input.WriteString("    " + line + "\n")
		}
	}

	ruleset := Header + `table inet odm
delete table inet odm
table inet odm {
  chain input {
    type filter hook input priority 0; policy accept;
` + input.String() + `  }
  chain output {
    type filter hook output priority 0; policy accept;
` + output.String() + `  }
}
`
	if err := env.WriteFile(firewallPath, ruleset, 0o600, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("firewall", err)}
	}

	unit := Header + `[Unit]
Description=Open Directory Manager firewall rules
Before=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f ` + firewallPath + `

[Install]
WantedBy=multi-user.target
`
	if err := env.WriteFile(firewallUnit, unit, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("firewall", err)}
	}
	return []policy.Result{runAll(ctx, env, "firewall",
		[]string{"systemctl", "daemon-reload"},
		[]string{"systemctl", "enable", "odm-firewall.service"},
		[]string{"nft", "-f", env.Path(firewallPath)},
	)}
}

func renderNftRule(rule policy.Firewall) string {
	parts := []string{}
	if rule.Source != "" && rule.Source != "any" {
		parts = append(parts, "ip saddr "+rule.Source)
	}
	switch rule.Protocol {
	case "", "any":
	case "icmp":
		parts = append(parts, "meta l4proto icmp")
	default:
		parts = append(parts, rule.Protocol)
		if rule.Port != 0 {
			parts = append(parts, fmt.Sprintf("dport %d", rule.Port))
		}
	}
	verdict := "accept"
	if rule.Action == "deny" {
		verdict = "drop"
	}
	parts = append(parts, verdict, "comment \""+rule.Name+"\"")
	return strings.Join(parts, " ")
}

// runAll runs commands in order and collapses them into one RSoP line.
func runAll(ctx context.Context, env Env, setting string, commands ...[]string) policy.Result {
	if env.Run == nil {
		return policy.Skip(setting, "no command runner")
	}
	for _, command := range commands {
		if _, err := env.Run.Run(ctx, command[0], command[1:]...); err != nil {
			return policy.Fail(setting, err)
		}
	}
	return policy.Ok(setting)
}
