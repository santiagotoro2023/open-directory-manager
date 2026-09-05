package apply

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"odm.example.org/agent/internal/policy"
)

func withPam(t *testing.T, env Env, services ...string) {
	t.Helper()
	// The module has to be on the machine before its name may be written into
	// a stack, so a test machine has one.
	write(t, env, oathModulePaths[0], "")
	for _, service := range services {
		write(t, env, "/etc/pam.d/"+service, "@include common-auth\n")
	}
}

func TestNothingIsWrittenOnAMachineWithoutTheModule(t *testing.T) {
	// A PAM stack naming a module that is not installed refuses every sign-in
	// through that service, which is worse than not asking for a code.
	env, _ := testEnv(t)
	write(t, env, "/etc/pam.d/login", "@include common-auth\n")

	results := applySecondFactor(context.Background(), policy.Settings{
		SecondFactor: &policy.SecondFactor{Enabled: true, Services: []string{"login"}},
	}, env)

	if len(results) != 1 || results[0].Status != "skipped" {
		t.Fatalf("the setting was applied anyway: %+v", results)
	}
	if strings.Contains(read(t, env, "/etc/pam.d/login"), "pam_oath.so") {
		t.Error("a module that is not installed was written into the stack")
	}
}

func TestTheCodeIsAskedForAfterThePasswordAndOnlyBehindTheGuard(t *testing.T) {
	env, _ := testEnv(t)
	withPam(t, env, "gdm-password", "login", "sshd", "sudo")

	applySecondFactor(context.Background(), policy.Settings{
		SecondFactor: &policy.SecondFactor{Enabled: true, Services: []string{"login", "ssh"}},
	}, env)

	for _, service := range []string{"gdm-password", "login", "sshd"} {
		body := read(t, env, "/etc/pam.d/"+service)
		if !strings.Contains(body, "pam_oath.so") {
			t.Errorf("%s does not ask for a code:\n%s", service, body)
		}
		// After the password. Asked first, the code is demanded of somebody
		// who then fails the password, and the prompts read backwards.
		if strings.Index(body, "pam_oath.so") < strings.Index(body, "common-auth") {
			t.Errorf("%s asks for the code before the password:\n%s", service, body)
		}
		// And never without something in front of it deciding whether this
		// account is asked at all. Unguarded, pam_oath refuses everybody who
		// has not enrolled — before the password prompt, root included.
		if strings.Index(body, factorGuard) > strings.Index(body, "pam_oath.so") {
			t.Errorf("%s runs pam_oath with no guard in front of it:\n%s", service, body)
		}
		if !strings.Contains(body, "success=1 default=ignore") {
			t.Errorf("%s does not skip pam_oath when the guard says so:\n%s", service, body)
		}
	}
	// sudo was not chosen, so it is left alone.
	if strings.Contains(read(t, env, "/etc/pam.d/sudo"), "pam_oath.so") {
		t.Error("a service that was not chosen was changed anyway")
	}
	// The file the module reads has to exist even empty: a missing one makes
	// pam_oath fail every authentication, which locks the machine.
	if _, err := os.Stat(env.Path(oathUsersFile)); err != nil {
		t.Error("the users file was not created, so nobody could sign in")
	}
	if _, err := os.Stat(env.Path(factorGuard)); err != nil {
		t.Error("the guard was named in the stack and never written")
	}
}

// The guard is what makes the setting safe. Run as shell, because it is shell
// that ships and every one of these answers is somebody's ability to sign in.
func TestTheGuardAsksOnlyWhoThePolicySaysToAsk(t *testing.T) {
	script := guardScript()

	for _, want := range []struct {
		name    string
		conf    string
		user    string
		uid     string
		oath    string
		since   string
		asked   bool
		because string
	}{
		{
			name: "a local account is never asked", conf: "GRACE_DAYS=0\n",
			user: "root", uid: "0", asked: false,
			because: "a machine whose control plane is unreachable has to stay repairable",
		},
		{
			name: "somebody enrolled is asked", conf: "GRACE_DAYS=14\n",
			user: "ada", uid: "1001", oath: "HOTP/T30/6 ada - ff", asked: true,
		},
		{
			name: "somebody exempt is never asked", conf: "EXEMPT=ada\nGRACE_DAYS=0\n",
			user: "ada", uid: "1001", oath: "HOTP/T30/6 ada - ff", asked: false,
		},
		{
			name: "only-for leaves everybody else alone",
			conf: "REQUIRE=%finance\nGRACE_DAYS=0\n",
			user: "ada", uid: "1001", oath: "HOTP/T30/6 ada - ff", asked: false,
		},
		{
			name: "somebody who has not enrolled is let in during the grace period",
			conf: "GRACE_DAYS=14\n",
			user: "ada", uid: "1001", since: "now", asked: false,
			because: "this is what a grace period is, and without it nobody could ever start",
		},
		{
			name: "and asked once it has passed", conf: "GRACE_DAYS=1\n",
			user: "ada", uid: "1001", since: "old", asked: true,
		},
		{
			name: "no settings at all asks nobody", conf: "",
			user: "ada", uid: "1001", asked: false,
		},
	} {
		t.Run(want.name, func(t *testing.T) {
			dir := t.TempDir()
			conf, oath, since := dir+"/conf", dir+"/oath", dir+"/since"
			write := func(path, body string) {
				if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if want.conf != "" {
				write(conf, want.conf)
			}
			write(oath, want.oath)
			switch want.since {
			case "now":
				write(since, fmt.Sprint(time.Now().Unix()))
			case "old":
				write(since, fmt.Sprint(time.Now().Add(-72*time.Hour).Unix()))
			}

			// The paths the shipped script uses, pointed at the temporary
			// ones, and id replaced so the test does not need real accounts.
			body := strings.NewReplacer(
				secondFactorPam, conf,
				oathUsersFile, oath,
				factorSince, since,
			).Replace(script)
			body = strings.Replace(body,
				`USER_ID="$(id -u "$USER_NAME" 2>/dev/null || echo 0)"`,
				`USER_ID="`+want.uid+`"`, 1)
			body = strings.Replace(body,
				`GROUPS_OF="$(id -nG "$USER_NAME" 2>/dev/null | tr 'A-Z' 'a-z')"`,
				`GROUPS_OF="users"`, 1)

			path := dir + "/guard"
			if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
				t.Fatal(err)
			}
			command := exec.Command("/bin/sh", path)
			command.Env = append(os.Environ(), "PAM_USER="+want.user)
			err := command.Run()
			asked := err != nil
			if asked != want.asked {
				t.Errorf("asked=%v, wanted %v. %s", asked, want.asked, want.because)
			}
		})
	}
}

func TestOnlyATextLoginGetsTheWalkthroughInline(t *testing.T) {
	// pam_exec can only ask a question where there is a terminal at session
	// open, and a graphical login has none.
	env, _ := testEnv(t)
	withPam(t, env, "gdm-password", "login", "sshd")
	applySecondFactor(context.Background(), policy.Settings{
		SecondFactor: &policy.SecondFactor{
			Enabled: true, SelfEnrol: true, Services: []string{"login", "ssh"},
		},
	}, env)

	for _, service := range []string{"login", "sshd"} {
		if !strings.Contains(read(t, env, "/etc/pam.d/"+service), enrolHelper) {
			t.Errorf("%s does not walk somebody through enrolling", service)
		}
	}
	if strings.Contains(read(t, env, "/etc/pam.d/gdm-password"), enrolHelper) {
		t.Error("the graphical login was given a prompt it cannot show")
	}
	// Which is why it gets a window instead.
	if !strings.Contains(read(t, env, enrolAutostart), "enrol-factor") {
		t.Error("a graphical session is never asked to enrol")
	}
}

func TestTurningTheSecondFactorOffTakesItOutOfEveryStack(t *testing.T) {
	// A policy switched off that left the module behind is a machine nobody
	// without a phone can sign in to.
	env, _ := testEnv(t)
	withPam(t, env, "gdm-password", "login", "sshd", "sudo")
	on := policy.Settings{
		SecondFactor: &policy.SecondFactor{
			Enabled: true, SelfEnrol: true,
			Services: []string{"login", "ssh", "sudo", "remote-desktop"},
		},
	}
	applySecondFactor(context.Background(), on, env)
	applySecondFactor(context.Background(), policy.Settings{
		SecondFactor: &policy.SecondFactor{Enabled: false},
	}, env)

	for _, service := range []string{"gdm-password", "login", "sshd", "sudo"} {
		body := read(t, env, "/etc/pam.d/"+service)
		if strings.Contains(body, "pam_oath.so") || strings.Contains(body, enrolHelper) {
			t.Errorf("%s still asks for a code:\n%s", service, body)
		}
		if !strings.Contains(body, "common-auth") {
			t.Errorf("%s lost the line it started with:\n%s", service, body)
		}
	}
	if _, err := os.Stat(env.Path(enrolAutostart)); err == nil {
		t.Error("the enrolment window was left behind")
	}
}

func TestAServiceTheMachineDoesNotHaveIsNotAFailure(t *testing.T) {
	// No gdm on a server, no xrdp on a desktop.
	env, _ := testEnv(t)
	results := applySecondFactor(context.Background(), policy.Settings{
		SecondFactor: &policy.SecondFactor{Enabled: true, Services: []string{"login"}},
	}, env)
	for _, result := range results {
		if result.Status == "failed" {
			t.Errorf("a missing service was reported as a failure: %s", result.Reason)
		}
	}
}

func TestTheUsersFileIsEmptiedRatherThanRemovedWhenNobodyIsEnrolled(t *testing.T) {
	env, _ := testEnv(t)
	if err := WriteOathUsers(env, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(env.Path(oathUsersFile)); err != nil {
		t.Fatal("the file pam_oath reads must exist even when it is empty")
	}
	if err := WriteOathUsers(env, []string{"HOTP/T30/6 bob - ff", "HOTP/T30/6 ada - ee"}); err != nil {
		t.Fatal(err)
	}
	body := read(t, env, oathUsersFile)
	if strings.Index(body, "ada") > strings.Index(body, "bob") {
		t.Errorf("the file is not written in a stable order:\n%s", body)
	}
}

// Removing the setting from a policy object arrives as nothing at all.
// Returning early on that left the lines on the machine for ever, so taking
// the setting away was the one thing that could not undo it.
func TestRemovingTheSettingEntirelyStillTakesItOffTheMachine(t *testing.T) {
	env, _ := testEnv(t)
	withPam(t, env, "gdm-password", "login", "sshd")
	applySecondFactor(context.Background(), policy.Settings{
		SecondFactor: &policy.SecondFactor{
			Enabled: true, SelfEnrol: true, Services: []string{"login", "ssh"},
		},
	}, env)

	// No second_factor at all — the setting was deleted, not switched off.
	results := applySecondFactor(context.Background(), policy.Settings{}, env)
	for _, result := range results {
		if result.Status == "failed" {
			t.Errorf("removing it failed: %s", result.Reason)
		}
	}
	for _, service := range []string{"gdm-password", "login", "sshd"} {
		body := read(t, env, "/etc/pam.d/"+service)
		if strings.Contains(body, "pam_oath.so") || strings.Contains(body, factorGuard) {
			t.Errorf("%s still asks for a code:\n%s", service, body)
		}
		if !strings.Contains(body, "common-auth") {
			t.Errorf("%s lost the line it started with:\n%s", service, body)
		}
	}
	if _, err := os.Stat(env.Path(factorGuard)); err == nil {
		t.Error("the guard was left behind")
	}
}

func TestAMachineThatNeverHadTheSettingSaysNothingAboutIt(t *testing.T) {
	env, _ := testEnv(t)
	if results := applySecondFactor(context.Background(), policy.Settings{}, env); len(results) != 0 {
		t.Errorf("a setting nobody configured produced %+v", results)
	}
}

// The grace period is counted from when the setting first reached the machine.
// Rewritten on every refresh it would restart every quarter of an hour and the
// grace would never end.
func TestTheGraceClockStartsOnceAndIsNotReset(t *testing.T) {
	env, _ := testEnv(t)
	withPam(t, env, "login")
	settings := policy.Settings{
		SecondFactor: &policy.SecondFactor{
			Enabled: true, Services: []string{"login"}, GraceDays: 14,
		},
	}
	applySecondFactor(context.Background(), settings, env)
	first := read(t, env, factorSince)

	applySecondFactor(context.Background(), settings, env)
	if read(t, env, factorSince) != first {
		t.Error("the grace period started again on the next refresh")
	}
}
