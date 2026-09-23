package apply

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Power, the screen lock and how the desktop looks.
//
// Power lands in four places, because a machine sleeps for four different
// reasons and only one of them is a signed-in desktop's timer:
//
//   - the machine's dconf database, which a GNOME session reads;
//   - the greeter's own dconf database, which is a different database with
//     its own defaults — GNOME's greeter suspends after twenty minutes on
//     mains unless told otherwise, so a machine nobody has signed into
//     turns itself off while the policy says never;
//   - systemd-logind, which acts with no session at all: the lid, the
//     buttons, and its own idle action, which is what reaches a machine
//     somebody locked and walked away from;
//   - UPower, which acts on a battery that is nearly flat, and whose action
//     is a machine turning itself off for a reason no timer explains.
//
// None of it is invented here — they are the documented settings, written
// the documented way, and locked when the policy says an operator's choice
// is not a suggestion.

const (
	logindDropIn      = "/etc/systemd/logind.conf.d/50-odm.conf"
	dconfSessionPath  = "/etc/dconf/db/odm.d/10-odm-session"
	dconfSessionLocks = "/etc/dconf/db/odm.d/locks/odm-session"
	// The greeter's copy of the power keys. Separate from the login-screen
	// applier's file so either setting may be used without the other, and
	// numbered after it so the two are read in a stable order.
	greeterPowerKeyfile       = "/etc/dconf/db/gdm.d/10-odm-power"
	debianGreeterPowerKeyfile = debianGreeterDir + "/96-odm-power"
	greeterPowerLocks         = "/etc/dconf/db/gdm.d/locks/odm-power"
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
		keyfile.WriteString(powerKeys(power, power.ScreenOffACMinutes,
			power.SuspendACMinutes, power.SuspendBatteryMinutes))

		if !power.AllowUserChange {
			for _, key := range []string{
				"/org/gnome/settings-daemon/plugins/power/sleep-inactive-ac-timeout",
				"/org/gnome/settings-daemon/plugins/power/sleep-inactive-battery-timeout",
				"/org/gnome/settings-daemon/plugins/power/sleep-inactive-ac-type",
				"/org/gnome/settings-daemon/plugins/power/sleep-inactive-battery-type",
				"/org/gnome/settings-daemon/plugins/power/power-button-action",
				"/org/gnome/settings-daemon/plugins/power/idle-dim",
				"/org/gnome/settings-daemon/plugins/power/idle-brightness",
				"/org/gnome/settings-daemon/plugins/power/power-saver-profile-on-low-battery",
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

	// And logind, which decides what the lid, the buttons and an idle machine
	// do whether or not anybody is signed in — a laptop closed at the login
	// screen is the case a session setting cannot reach.
	if s.Power != nil {
		if err := env.WriteFile(
			logindDropIn, logindPower(*s.Power), 0o644, "root", "root",
		); err != nil {
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

	// The greeter, which has to be written after that dconf update: its own
	// database is built by a different command on Debian, and the reload
	// below is what makes a greeter already on screen read either of them.
	if s.Power != nil {
		results = append(results, applyGreeterPower(ctx, *s.Power, env)...)
		results = append(results, applyBatteryCritical(ctx, *s.Power, env)...)
	}
	return results
}

// applyGreeterPower writes the same power keys into the database the greeter
// reads, which is not the one a session reads.
//
// Both places it can live are written: /etc/dconf/db/gdm.d, which is where
// GNOME documents it, and /usr/share/gdm/dconf, which is where Debian's
// greeter actually looks (see the login-screen applier for how that was
// found out the hard way).
func applyGreeterPower(ctx context.Context, power policy.PowerSettings, env Env) []policy.Result {
	body := Header + powerKeys(power, power.LoginScreenScreenOffMinutes,
		power.LoginScreenSuspendMinutes, power.LoginScreenSuspendMinutes)

	if err := env.WriteFile(greeterProfilePath, greeterProfile(env), 0o644,
		"root", "root"); err != nil {
		return []policy.Result{policy.Fail("power:login_screen", err)}
	}
	if err := env.WriteFile(greeterPowerKeyfile, sortedKeyfile(body), 0o644,
		"root", "root"); err != nil {
		return []policy.Result{policy.Fail("power:login_screen", err)}
	}
	// Nobody is signed in at the greeter, so there is no "let people change
	// this" to honour: the keys are locked, always, or the greeter's own
	// settings win over the policy's.
	locks := Header
	for _, key := range []string{
		"/org/gnome/settings-daemon/plugins/power/sleep-inactive-ac-timeout",
		"/org/gnome/settings-daemon/plugins/power/sleep-inactive-battery-timeout",
		"/org/gnome/settings-daemon/plugins/power/sleep-inactive-ac-type",
		"/org/gnome/settings-daemon/plugins/power/sleep-inactive-battery-type",
		"/org/gnome/desktop/session/idle-delay",
	} {
		locks += key + "\n"
	}
	if err := env.WriteFile(greeterPowerLocks, locks, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("power:login_screen", err)}
	}

	results := []policy.Result{runAll(ctx, env, "power:login_screen",
		[]string{"dconf", "update"})}

	if _, err := os.Stat(env.Path(debianGreeterDir)); err == nil {
		if err := env.WriteFile(
			debianGreeterPowerKeyfile, sortedKeyfile(body), 0o644, "root", "root",
		); err != nil {
			results = append(results, policy.Fail("power:login_screen", err))
		} else {
			results = append(results, runAll(ctx, env, "power:login_screen",
				[]string{debianGreeterConfig}))
		}
	}
	reloadGreeter(ctx, env)
	return results
}

// powerKeys renders GNOME's power and session keys for one database. The
// greeter's and the session's differ only in the timers they are given,
// which is why the timers are arguments and the rest is not.
func powerKeys(power policy.PowerSettings, screenOffMinutes, suspendAC, suspendBattery int) string {
	var out strings.Builder
	fmt.Fprintf(&out, "\n[org/gnome/settings-daemon/plugins/power]\n")
	// GNOME counts in seconds, and 0 means never — the same as the console's
	// own 0, so nothing has to be translated but the unit. The type is how
	// GNOME says "never" rather than "in zero seconds", and both have to be
	// written: a timeout of 0 with a type of suspend is not never.
	fmt.Fprintf(&out, "sleep-inactive-ac-timeout=%d\n", suspendAC*60)
	fmt.Fprintf(&out, "sleep-inactive-battery-timeout=%d\n", suspendBattery*60)
	fmt.Fprintf(&out, "sleep-inactive-ac-type='%s'\n", sleepType(suspendAC))
	fmt.Fprintf(&out, "sleep-inactive-battery-type='%s'\n", sleepType(suspendBattery))
	fmt.Fprintf(&out, "power-button-action='%s'\n", gnomeAction(power.PowerButtonAction))
	fmt.Fprintf(&out, "idle-dim=%t\n", boolOr(power.DimScreen, true))
	fmt.Fprintf(&out, "idle-brightness=%d\n", intOr(power.IdleBrightnessPercent, 30))
	fmt.Fprintf(&out, "power-saver-profile-on-low-battery=%t\n",
		boolOr(power.PowerSaverOnLowBattery, true))
	// Blanking the screen is a session setting rather than a power one.
	// GNOME has one blanking timer, not one per power source, so the mains
	// value is the one that reaches it.
	fmt.Fprintf(&out, "\n[org/gnome/desktop/session]\n")
	fmt.Fprintf(&out, "idle-delay=uint32 %d\n", screenOffMinutes*60)
	return out.String()
}

// logindPower is the drop-in that decides what the hardware does with no
// session involved.
func logindPower(power policy.PowerSettings) string {
	lid := logindAction(power.LidCloseAction)
	external := lid
	if power.LidCloseActionExternalPower != "" {
		external = logindAction(power.LidCloseActionExternalPower)
	}
	docked := lid
	if power.LidCloseActionDocked != "" {
		docked = logindAction(power.LidCloseActionDocked)
	}
	suspendKey := "suspend"
	if power.SuspendKeyAction != "" {
		suspendKey = logindAction(power.SuspendKeyAction)
	}
	hibernateKey := "hibernate"
	if power.HibernateKeyAction != "" {
		hibernateKey = logindAction(power.HibernateKeyAction)
	}

	// Absent reads as allowed, never as forbidden: a policy written before
	// these existed must not stop a fleet suspending at all.
	suspend := boolOr(power.AllowSuspend, true)
	hibernate := boolOr(power.AllowHibernate, true)

	out := Header + "[Login]\n" +
		"HandleLidSwitch=" + lid + "\n" +
		"HandleLidSwitchExternalPower=" + external + "\n" +
		"HandleLidSwitchDocked=" + docked + "\n" +
		"HandlePowerKey=" + logindAction(power.PowerButtonAction) + "\n" +
		"HandleSuspendKey=" + suspendKey + "\n" +
		"HandleHibernateKey=" + hibernateKey + "\n"

	// logind's own idle action. Never with no timer: IdleActionSec is what
	// arms it, and an action with no time is an action that never happens —
	// so "ignore" is written rather than left to mean itself by accident.
	if power.IdleAction == "" || power.IdleAction == "ignore" || power.IdleActionMinutes == 0 {
		out += "IdleAction=ignore\n"
	} else {
		out += "IdleAction=" + logindAction(power.IdleAction) + "\n"
		out += fmt.Sprintf("IdleActionSec=%dmin\n", power.IdleActionMinutes)
	}

	// The flat refusals, which are the only settings here that hold against
	// something on the machine asking to suspend rather than against a
	// timer. Hybrid sleep and suspend-then-hibernate are both halves, so
	// they need both permissions.
	out += "AllowSuspend=" + logindYes(suspend) + "\n"
	out += "AllowHibernation=" + logindYes(hibernate) + "\n"
	out += "AllowHybridSleep=" + logindYes(suspend && hibernate) + "\n"
	out += "AllowSuspendThenHibernate=" + logindYes(suspend && hibernate) + "\n"
	return out
}

// logindYes is systemd's spelling of a boolean, which is not the "true" and
// "false" an apt configuration file wants — hence a second one.
func logindYes(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

// boolOr and intOr read a value the console may not have sent, because an
// agent can be newer than the console handing it a policy document.
func boolOr(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func intOr(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
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
