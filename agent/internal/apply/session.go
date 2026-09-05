package apply

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Power, the screen lock and how the desktop looks.
//
// All three land in the same two places: systemd-logind, which decides what
// the hardware does whether or not anybody is signed in, and the machine's
// dconf database, which is what a GNOME session reads. Neither is invented
// here — they are the documented settings, written the documented way, and
// locked when the policy says an operator's choice is not a suggestion.

const (
	logindDropIn      = "/etc/systemd/logind.conf.d/50-odm.conf"
	dconfSessionPath  = "/etc/dconf/db/odm.d/10-odm-session"
	dconfSessionLocks = "/etc/dconf/db/odm.d/locks/odm-session"
)

func applySession(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.Power == nil && s.ScreenLock == nil && s.DesktopTheme == nil {
		return nil
	}
	var results []policy.Result

	// The dconf profile, without which everything below is written and never
	// read. Shared with the wallpaper applier, and written by whichever of
	// them runs — the same two lines either way.
	if err := env.WriteFile(
		dconfProfilePath, "user-db:user\nsystem-db:odm\n", 0o644, "root", "root",
	); err != nil {
		return []policy.Result{policy.Fail("session", err)}
	}

	var keyfile, locks strings.Builder
	keyfile.WriteString(Header)

	if s.Power != nil {
		power := *s.Power
		fmt.Fprintf(&keyfile, "\n[org/gnome/settings-daemon/plugins/power]\n")
		// GNOME counts in seconds, and 0 means never — the same as the
		// console's own 0, so nothing has to be translated but the unit.
		fmt.Fprintf(&keyfile, "sleep-inactive-ac-timeout=%d\n", power.SuspendACMinutes*60)
		fmt.Fprintf(&keyfile, "sleep-inactive-battery-timeout=%d\n",
			power.SuspendBatteryMinutes*60)
		fmt.Fprintf(&keyfile, "sleep-inactive-ac-type='%s'\n", sleepType(power.SuspendACMinutes))
		fmt.Fprintf(&keyfile, "sleep-inactive-battery-type='%s'\n",
			sleepType(power.SuspendBatteryMinutes))
		fmt.Fprintf(&keyfile, "power-button-action='%s'\n",
			gnomeAction(power.PowerButtonAction))
		fmt.Fprintf(&keyfile, "\n[org/gnome/settings-daemon/plugins/power]\n")
		fmt.Fprintf(&keyfile, "idle-dim=true\n")
		// Blanking the screen is a session setting rather than a power one.
		fmt.Fprintf(&keyfile, "\n[org/gnome/desktop/session]\n")
		fmt.Fprintf(&keyfile, "idle-delay=uint32 %d\n", power.ScreenOffACMinutes*60)

		if !power.AllowUserChange {
			for _, key := range []string{
				"/org/gnome/settings-daemon/plugins/power/sleep-inactive-ac-timeout",
				"/org/gnome/settings-daemon/plugins/power/sleep-inactive-battery-timeout",
				"/org/gnome/settings-daemon/plugins/power/power-button-action",
				"/org/gnome/desktop/session/idle-delay",
			} {
				locks.WriteString(key + "\n")
			}
		}
	}

	if s.ScreenLock != nil {
		lock := *s.ScreenLock
		fmt.Fprintf(&keyfile, "\n[org/gnome/desktop/screensaver]\n")
		fmt.Fprintf(&keyfile, "lock-enabled=%t\n", lock.LockEnabled)
		fmt.Fprintf(&keyfile, "lock-delay=uint32 %d\n", lock.LockDelaySeconds)
		fmt.Fprintf(&keyfile, "show-notifications=%t\n", lock.ShowNotifications)
		fmt.Fprintf(&keyfile, "ubuntu-lock-on-suspend=%t\n", lock.LockOnSuspend)
		// Where the screen blanks, which is what starts the lock delay. Only
		// when the power settings have not already said: two policies writing
		// one key is a disagreement the machine cannot resolve.
		if s.Power == nil {
			fmt.Fprintf(&keyfile, "\n[org/gnome/desktop/session]\n")
			fmt.Fprintf(&keyfile, "idle-delay=uint32 %d\n", lock.IdleMinutes*60)
		}
		if !lock.AllowUserChange {
			for _, key := range []string{
				"/org/gnome/desktop/screensaver/lock-enabled",
				"/org/gnome/desktop/screensaver/lock-delay",
				"/org/gnome/desktop/screensaver/show-notifications",
			} {
				locks.WriteString(key + "\n")
			}
			if s.Power == nil {
				locks.WriteString("/org/gnome/desktop/session/idle-delay\n")
			}
		}
	}

	if s.DesktopTheme != nil {
		theme := *s.DesktopTheme
		fmt.Fprintf(&keyfile, "\n[org/gnome/desktop/interface]\n")
		for key, value := range map[string]string{
			"gtk-theme":           theme.GtkTheme,
			"icon-theme":          theme.IconTheme,
			"cursor-theme":        theme.CursorTheme,
			"font-name":           theme.InterfaceFont,
			"document-font-name":  theme.DocumentFont,
			"monospace-font-name": theme.MonospaceFont,
			"color-scheme":        theme.ColourScheme,
		} {
			if value == "" {
				continue // not set is not the same as set to nothing
			}
			fmt.Fprintf(&keyfile, "%s='%s'\n", key, dconfEscape(value))
			if !theme.AllowUserChange {
				locks.WriteString("/org/gnome/desktop/interface/" + key + "\n")
			}
		}
	}

	if err := env.WriteFile(dconfSessionPath, sortedKeyfile(keyfile.String()), 0o644,
		"root", "root"); err != nil {
		results = append(results, policy.Fail("session", err))
		return results
	}
	if err := env.WriteFile(dconfSessionLocks, Header+locks.String(), 0o644,
		"root", "root"); err != nil {
		results = append(results, policy.Fail("session", err))
		return results
	}

	// And logind, which decides what the lid and the power button do whether
	// or not anybody is signed in — a laptop closed at the login screen is
	// the case a session setting cannot reach.
	if s.Power != nil {
		drop := Header +
			"[Login]\n" +
			"HandleLidSwitch=" + logindAction(s.Power.LidCloseAction) + "\n" +
			"HandleLidSwitchExternalPower=" + logindAction(s.Power.LidCloseAction) + "\n" +
			"HandlePowerKey=" + logindAction(s.Power.PowerButtonAction) + "\n"
		if err := env.WriteFile(logindDropIn, drop, 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail("power", err))
		} else {
			// Reloaded rather than restarted: restarting logind ends every
			// session on the machine, which is not what changing a lid
			// setting should do.
			results = append(results,
				runAll(ctx, env, "power", []string{"systemctl", "reload-or-restart", "systemd-logind"}))
		}
	}

	results = append(results, runAll(ctx, env, "session", []string{"dconf", "update"}))
	return results
}

// sortedKeyfile merges repeated group headers, because a keyfile with the
// same group twice keeps only the last one and the settings written under
// the first are silently dropped.
func sortedKeyfile(body string) string {
	groups := map[string][]string{}
	var order []string
	current := ""
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "" || strings.HasPrefix(trimmed, "#"):
			continue
		case strings.HasPrefix(trimmed, "["):
			current = trimmed
			if _, seen := groups[current]; !seen {
				groups[current] = nil
				order = append(order, current)
			}
		case current != "":
			groups[current] = append(groups[current], trimmed)
		}
	}
	out := &strings.Builder{}
	out.WriteString(Header)
	for _, group := range order {
		out.WriteString("\n" + group + "\n")
		lines := groups[group]
		sort.Strings(lines)
		seen := map[string]bool{}
		for _, line := range lines {
			key, _, _ := strings.Cut(line, "=")
			if seen[key] {
				continue // the first writer of a key wins, deterministically
			}
			seen[key] = true
			out.WriteString(line + "\n")
		}
	}
	return out.String()
}

// sleepType is what GNOME calls doing nothing, which it expresses by the type
// rather than by the timeout.
func sleepType(minutes int) string {
	if minutes == 0 {
		return "nothing"
	}
	return "suspend"
}

func gnomeAction(action string) string {
	switch action {
	case "hibernate":
		return "hibernate"
	case "poweroff":
		return "interactive"
	case "lock", "ignore":
		return "nothing"
	default:
		return "suspend"
	}
}

func logindAction(action string) string {
	switch action {
	case "hibernate":
		return "hibernate"
	case "poweroff":
		return "poweroff"
	case "lock":
		return "lock"
	case "ignore":
		return "ignore"
	default:
		return "suspend"
	}
}
