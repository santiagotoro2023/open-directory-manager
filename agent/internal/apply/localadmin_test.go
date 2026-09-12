package apply

import (
	"context"
	"os"
	"testing"
	"time"

	"odm.example.org/agent/internal/policy"
)

// seedLocalAdmin puts a machine into the state it would be in after a
// previous run had actually created the account — without going through
// chpasswd, which needs root and is not what this is testing.
func seedLocalAdmin(t *testing.T, env Env, account string) {
	t.Helper()
	if err := saveLocalAdminState(env, localAdminState{
		Account: account, Rotated: time.Now().UTC(), Password: "irrelevant",
	}); err != nil {
		t.Fatal(err)
	}
	if err := env.WriteFile(
		"/etc/sudoers.d/odm-local-administrator", Header+account+" ALL=(ALL:ALL) ALL\n",
		0o440, "", "",
	); err != nil {
		t.Fatal(err)
	}
}

// A policy that stops naming a local administrator has to take the account it
// created back off the machine — otherwise unlinking the GPO leaves an
// account nobody in the console can see on every machine it was ever pushed
// to, which is exactly what somebody previously had to clean up by hand on
// each one.
func TestRemovingTheSettingRemovesTheAccountItCreated(t *testing.T) {
	env, runner := testEnv(t)
	seedLocalAdmin(t, env, "odm-admin")

	results := applyLocalAdministrator(context.Background(), policy.Settings{}, env)

	if len(results) != 1 || results[0].Status != "success" {
		t.Fatalf("the removal was not reported cleanly: %+v", results)
	}
	if !runner.ran("userdel", "odm-admin") {
		t.Error("the account was never removed")
	}
	if _, err := os.Stat(env.Path("/etc/sudoers.d/odm-local-administrator")); !os.IsNotExist(err) {
		t.Error("sudo rights were left behind")
	}
	if _, err := os.Stat(env.Path(localAdminStatePath)); !os.IsNotExist(err) {
		t.Error("the machine still remembers an account it no longer has")
	}

	// A machine that never had one should not report removing it on every
	// run of a policy that simply never mentions the setting.
	if results := applyLocalAdministrator(context.Background(), policy.Settings{}, env); results != nil {
		t.Errorf("nothing to remove a second time, got: %+v", results)
	}
}

// A local account still logged in when the policy drops it must still go —
// removeLocalAdministrator asks userdel to force it, not leave a service
// account behind because a stale session happens to be open.
func TestRemovalForcesTheAccountEvenIfSignedIn(t *testing.T) {
	env, runner := testEnv(t)
	seedLocalAdmin(t, env, "odm-admin")

	applyLocalAdministrator(context.Background(), policy.Settings{}, env)

	for _, command := range runner.commands {
		if command[0] == "userdel" {
			if !contains(command, "-f") {
				t.Errorf("userdel was not forced: %v", command)
			}
			return
		}
	}
	t.Fatal("userdel was never run")
}

// Renaming the account is a removal of the old one, not a machine left
// holding both because only the new name was ever looked for.
func TestRenamingTheAccountRemovesTheOldOneFirst(t *testing.T) {
	env, runner := testEnv(t)
	seedLocalAdmin(t, env, "odm-admin-old")

	// chpasswd is not available in this test environment (it needs root),
	// so the new account's creation is expected to fail after the old one is
	// removed — what matters here is that the old one goes regardless.
	applyLocalAdministrator(context.Background(), policy.Settings{
		LocalAdministrator: &policy.LocalAdministrator{Account: "odm-admin-new"},
	}, env)

	if !runner.ran("userdel", "odm-admin-old") {
		t.Error("the old account was never removed")
	}
}

func contains(haystack []string, needle string) bool {
	for _, value := range haystack {
		if value == needle {
			return true
		}
	}
	return false
}
