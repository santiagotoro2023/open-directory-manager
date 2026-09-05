package apply

import (
	"context"
	"os"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func withPam(t *testing.T, env Env, services ...string) {
	t.Helper()
	for _, service := range services {
		write(t, env, "/etc/pam.d/"+service, "@include common-auth\n")
	}
}

func TestTheSecondFactorGoesAtTheTopOfTheStackItIsAskedFor(t *testing.T) {
	// After the password has been accepted is too late to refuse the sign-in.
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
		if strings.Index(body, "pam_oath.so") > strings.Index(body, "common-auth") {
			t.Errorf("%s asks for the code after the password is accepted", service)
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
