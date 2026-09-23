package apply

import (
	"context"
	"os"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func TestTheGreeterGetsItsOwnCopyOfThePowerKeys(t *testing.T) {
	// The greeter reads a different dconf database with its own defaults —
	// GNOME's suspends after twenty minutes on mains — so a machine nobody
	// has signed into sleeps on settings no session policy ever reached.
	env, _ := testEnv(t)
	applySession(context.Background(), policy.Settings{
		Power: &policy.PowerSettings{
			SuspendACMinutes:            0,
			LoginScreenSuspendMinutes:   0,
			LoginScreenScreenOffMinutes: 15,
		},
	}, env)

	greeter := read(t, env, greeterPowerKeyfile)
	if !strings.Contains(greeter, "sleep-inactive-ac-type='nothing'") ||
		!strings.Contains(greeter, "sleep-inactive-ac-timeout=0") {
		t.Errorf("the greeter was not told never to suspend:\n%s", greeter)
	}
	if !strings.Contains(greeter, "idle-delay=uint32 900") {
		t.Errorf("the greeter's screen-off time is not the one set:\n%s", greeter)
	}
	// Nobody is signed in at the greeter, so there is no user choice to
	// respect: the keys are locked whatever the session policy says.
	if !strings.Contains(read(t, env, greeterPowerLocks), "sleep-inactive-ac-timeout") {
		t.Error("the greeter's keys were not locked")
	}
	if !strings.Contains(read(t, env, greeterProfilePath), "system-db:gdm") {
		t.Error("the greeter profile was not written, so none of it is read")
	}
}

func TestTheGreeterKeepsItsOwnTimersRatherThanTheSessionOnes(t *testing.T) {
	env, _ := testEnv(t)
	applySession(context.Background(), policy.Settings{
		Power: &policy.PowerSettings{
			SuspendACMinutes:            20,
			ScreenOffACMinutes:          10,
			LoginScreenSuspendMinutes:   0,
			LoginScreenScreenOffMinutes: 0,
		},
	}, env)
	if greeter := read(t, env, greeterPowerKeyfile); !strings.Contains(
		greeter, "sleep-inactive-ac-type='nothing'") {
		t.Errorf("the session's timer reached the greeter:\n%s", greeter)
	}
	if session := read(t, env, dconfSessionPath); !strings.Contains(
		session, "sleep-inactive-ac-timeout=1200") {
		t.Errorf("the greeter's timer reached the session:\n%s", session)
	}
}

func TestSuspendCanBeRefusedOutrightRatherThanOnlyTimedOut(t *testing.T) {
	no, yes := false, true
	env, _ := testEnv(t)
	applySession(context.Background(), policy.Settings{
		Power: &policy.PowerSettings{AllowSuspend: &no, AllowHibernate: &yes},
	}, env)
	drop := read(t, env, logindDropIn)
	if !strings.Contains(drop, "AllowSuspend=no") {
		t.Errorf("suspend was not refused:\n%s", drop)
	}
	// Both halves are needed for either of the combined ones.
	if !strings.Contains(drop, "AllowHybridSleep=no") ||
		!strings.Contains(drop, "AllowSuspendThenHibernate=no") {
		t.Errorf("a combined sleep survived suspend being refused:\n%s", drop)
	}
	if !strings.Contains(drop, "AllowHibernation=yes") {
		t.Errorf("hibernation was refused when it was allowed:\n%s", drop)
	}
}

func TestAPolicyWithoutTheseFieldsStillAllowsSleeping(t *testing.T) {
	// An agent can be newer than the console handing it a document. Absent
	// has to read as the default, never as "no": the alternative is a fleet
	// that cannot suspend because of a field nobody set.
	env, _ := testEnv(t)
	applySession(context.Background(), policy.Settings{
		Power: &policy.PowerSettings{LidCloseAction: "suspend"},
	}, env)
	drop := read(t, env, logindDropIn)
	if !strings.Contains(drop, "AllowSuspend=yes") ||
		!strings.Contains(drop, "AllowHibernation=yes") {
		t.Errorf("an unset field refused to sleep:\n%s", drop)
	}
	if keyfile := read(t, env, dconfSessionPath); !strings.Contains(keyfile, "idle-dim=true") {
		t.Errorf("an unset field turned dimming off:\n%s", keyfile)
	}
}

func TestTheLidHasOneAnswerPerSituation(t *testing.T) {
	env, _ := testEnv(t)
	applySession(context.Background(), policy.Settings{
		Power: &policy.PowerSettings{
			LidCloseAction:              "suspend",
			LidCloseActionExternalPower: "ignore",
			LidCloseActionDocked:        "",
			PowerButtonAction:           "lock",
			SuspendKeyAction:            "ignore",
		},
	}, env)
	drop := read(t, env, logindDropIn)
	for _, want := range []string{
		"HandleLidSwitch=suspend",
		"HandleLidSwitchExternalPower=ignore",
		// Empty is "the same as closing the lid", which is what ODM meant
		// before these fields existed.
		"HandleLidSwitchDocked=suspend",
		"HandlePowerKey=lock",
		"HandleSuspendKey=ignore",
		"HandleHibernateKey=hibernate",
	} {
		if !strings.Contains(drop, want) {
			t.Errorf("missing %q:\n%s", want, drop)
		}
	}
}

func TestLogindIdleActionNeedsATimeToBeArmed(t *testing.T) {
	env, _ := testEnv(t)
	applySession(context.Background(), policy.Settings{
		Power: &policy.PowerSettings{IdleAction: "suspend", IdleActionMinutes: 0},
	}, env)
	if drop := read(t, env, logindDropIn); !strings.Contains(drop, "IdleAction=ignore") {
		t.Errorf("an action with no time was armed anyway:\n%s", drop)
	}

	applySession(context.Background(), policy.Settings{
		Power: &policy.PowerSettings{IdleAction: "poweroff", IdleActionMinutes: 45},
	}, env)
	drop := read(t, env, logindDropIn)
	if !strings.Contains(drop, "IdleAction=poweroff") ||
		!strings.Contains(drop, "IdleActionSec=45min") {
		t.Errorf("the idle action was not armed:\n%s", drop)
	}
}

func TestTheBatteryActionEditsUPowersFileRatherThanReplacingIt(t *testing.T) {
	env, runner := testEnv(t)
	shipped := "[UPower]\n# A comment the distribution wrote\n" +
		"PercentageLow=20\nPercentageAction=2.0\nCriticalPowerAction=HybridSleep\n"
	if err := os.MkdirAll(env.Path("/etc/UPower"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(env.Path(upowerConf), []byte(shipped), 0o644); err != nil {
		t.Fatal(err)
	}

	applyBatteryCritical(context.Background(), policy.PowerSettings{
		CriticalBatteryAction: "poweroff", CriticalBatteryPercent: 5,
	}, env)

	conf := read(t, env, upowerConf)
	if !strings.Contains(conf, "CriticalPowerAction=PowerOff") ||
		!strings.Contains(conf, "PercentageAction=5") ||
		!strings.Contains(conf, "UsePercentageForPolicy=true") {
		t.Errorf("the keys were not set:\n%s", conf)
	}
	if !strings.Contains(conf, "PercentageLow=20") ||
		!strings.Contains(conf, "# A comment the distribution wrote") {
		t.Errorf("the rest of the distribution's file was lost:\n%s", conf)
	}
	if strings.Count(conf, "CriticalPowerAction=") != 1 {
		t.Errorf("the key ended up in the file twice:\n%s", conf)
	}
	if !runner.ran("systemctl", "try-restart") {
		t.Error("upower was not asked to re-read its configuration")
	}

	// And clearing the setting puts the machine back rather than leaving
	// ODM's last answer behind for ever.
	applyBatteryCritical(context.Background(), policy.PowerSettings{}, env)
	if conf := read(t, env, upowerConf); conf != shipped {
		t.Errorf("the distribution's own file did not come back:\n%s", conf)
	}
	if _, err := os.Stat(env.Path(upowerOriginal)); err == nil {
		t.Error("the copy of the original was kept after it was restored")
	}
}

func TestNoBatteryActionOnAMachineWithoutUPowerIsNotAFailure(t *testing.T) {
	env, _ := testEnv(t)
	results := applyBatteryCritical(context.Background(), policy.PowerSettings{
		CriticalBatteryAction: "hibernate",
	}, env)
	if len(results) != 1 || results[0].Status != "skipped" {
		t.Errorf("a machine without UPower reported %+v", results)
	}
}

func TestUPowerKeysAreAddedWhenTheFileDoesNotMentionThem(t *testing.T) {
	out := setUPowerKeys("[UPower]\nPercentageLow=20\n",
		map[string]string{"CriticalPowerAction": "PowerOff"})
	if !strings.Contains(out, "CriticalPowerAction=PowerOff") {
		t.Errorf("the key was not added:\n%s", out)
	}
	if !strings.Contains(out, "PercentageLow=20") {
		t.Errorf("an existing key was lost:\n%s", out)
	}
	// Under the group, not after the file's last line, which on a file with
	// a second group would be a key in the wrong one.
	group := strings.Index(out, "[UPower]")
	if strings.Index(out, "CriticalPowerAction=") < group {
		t.Errorf("the key landed outside the group:\n%s", out)
	}
	// A commented-out key is a key: setting it means rewriting that line,
	// not adding a second one below it.
	out = setUPowerKeys("[UPower]\n#CriticalPowerAction=Hibernate\n",
		map[string]string{"CriticalPowerAction": "PowerOff"})
	if strings.Count(out, "CriticalPowerAction=") != 1 {
		t.Errorf("a commented key was left beside the real one:\n%s", out)
	}
}
