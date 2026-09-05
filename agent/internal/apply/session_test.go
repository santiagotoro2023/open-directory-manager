package apply

import (
	"context"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func TestPowerIsWrittenToLogindAsWellAsTheDesktop(t *testing.T) {
	// A laptop closed at the login screen has no session to hold a setting,
	// which is exactly the case a desktop-only answer misses.
	env, runner := testEnv(t)
	applySession(context.Background(), policy.Settings{
		Power: &policy.PowerSettings{
			ScreenOffACMinutes:    10,
			SuspendBatteryMinutes: 30,
			SuspendACMinutes:      0,
			LidCloseAction:        "hibernate",
			PowerButtonAction:     "poweroff",
		},
	}, env)

	drop := read(t, env, logindDropIn)
	if !strings.Contains(drop, "HandleLidSwitch=hibernate") ||
		!strings.Contains(drop, "HandlePowerKey=poweroff") {
		t.Errorf("logind was not told:\n%s", drop)
	}
	// Reloaded, never restarted: restarting logind ends every session.
	if !runner.ran("systemctl", "reload-or-restart") {
		t.Error("logind was not asked to re-read its configuration")
	}
	for _, command := range runner.commands {
		if command[0] == "systemctl" && command[1] == "restart" {
			t.Error("logind was restarted, which would end every session on the machine")
		}
	}

	keyfile := read(t, env, dconfSessionPath)
	if !strings.Contains(keyfile, "sleep-inactive-battery-timeout=1800") {
		t.Errorf("minutes were not turned into the seconds GNOME reads:\n%s", keyfile)
	}
	// 0 is never, which GNOME expresses by the type rather than the timeout.
	if !strings.Contains(keyfile, "sleep-inactive-ac-type='nothing'") {
		t.Errorf("never was written as a timeout of zero rather than as never:\n%s", keyfile)
	}
}

func TestOneKeyIsWrittenOnceEvenWhenTwoSettingsWantIt(t *testing.T) {
	// A keyfile with the same group twice keeps only the last one, so
	// settings written under the first are silently dropped.
	env, _ := testEnv(t)
	applySession(context.Background(), policy.Settings{
		Power:      &policy.PowerSettings{ScreenOffACMinutes: 10},
		ScreenLock: &policy.ScreenLock{IdleMinutes: 5, LockEnabled: true},
	}, env)

	keyfile := read(t, env, dconfSessionPath)
	if strings.Count(keyfile, "[org/gnome/desktop/session]") != 1 {
		t.Errorf("a group appears twice:\n%s", keyfile)
	}
	if strings.Count(keyfile, "idle-delay=") != 1 {
		t.Errorf("one key was written twice:\n%s", keyfile)
	}
	// Power wins where both would set it, and says so by writing 600.
	if !strings.Contains(keyfile, "idle-delay=uint32 600") {
		t.Errorf("the screen-off time is not the one Power set:\n%s", keyfile)
	}
}

func TestLockingASettingIsWhatStopsSomebodyChangingIt(t *testing.T) {
	env, _ := testEnv(t)
	applySession(context.Background(), policy.Settings{
		ScreenLock: &policy.ScreenLock{IdleMinutes: 5, LockEnabled: true, AllowUserChange: false},
	}, env)
	locks := read(t, env, dconfSessionLocks)
	if !strings.Contains(locks, "/org/gnome/desktop/screensaver/lock-enabled") {
		t.Errorf("nothing was locked:\n%s", locks)
	}

	applySession(context.Background(), policy.Settings{
		ScreenLock: &policy.ScreenLock{IdleMinutes: 5, LockEnabled: true, AllowUserChange: true},
	}, env)
	if body := read(t, env, dconfSessionLocks); strings.Contains(body, "lock-enabled") {
		t.Errorf("the lock stayed after the policy allowed a change:\n%s", body)
	}
}

func TestAThemeLeftEmptyIsLeftAloneRatherThanSetToNothing(t *testing.T) {
	env, _ := testEnv(t)
	applySession(context.Background(), policy.Settings{
		DesktopTheme: &policy.DesktopTheme{GtkTheme: "Adwaita-dark", AllowUserChange: true},
	}, env)
	keyfile := read(t, env, dconfSessionPath)
	if !strings.Contains(keyfile, "gtk-theme='Adwaita-dark'") {
		t.Errorf("the theme was not written:\n%s", keyfile)
	}
	if strings.Contains(keyfile, "icon-theme=") {
		t.Errorf("an empty field was written as an empty value:\n%s", keyfile)
	}
}

func TestTheWelcomeTourIsHiddenInEtcRatherThanDeletedFromUsr(t *testing.T) {
	// Deleting the distribution's own file is how a package upgrade puts it
	// back and nobody notices.
	env, _ := testEnv(t)
	applyFirstRun(context.Background(), policy.Settings{
		FirstRun: &policy.FirstRun{DisableTour: true, DisableWelcomeDialog: true,
			Message: "Managed by Example Corp."},
	}, env)

	entry := read(t, env, tourAutostart)
	if !strings.Contains(entry, "Hidden=true") {
		t.Errorf("the tour is not hidden:\n%s", entry)
	}
	if !strings.Contains(read(t, env, firstRunKeyfile), "welcome-dialog-last-shown-version") {
		t.Error("the shell's welcome dialog was not answered")
	}
	if !strings.Contains(read(t, env, motdPath), "Managed by Example Corp.") {
		t.Error("the message of the day was not written")
	}
}
