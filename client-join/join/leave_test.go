package join

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type leaveRunner struct {
	commands [][]string
	fail     map[string]bool
}

func (r *leaveRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	r.commands = append(r.commands, append([]string{name}, args...))
	return "", nil
}

func (r *leaveRunner) RunWithInput(
	_ context.Context, _ string, name string, args ...string,
) (string, error) {
	r.commands = append(r.commands, append([]string{name}, args...))
	if r.fail[name] {
		return "", os.ErrPermission
	}
	return "", nil
}

func joinedMachine(t *testing.T) (Env, *leaveRunner) {
	t.Helper()
	root := t.TempDir()
	for _, path := range []string{KeytabPath, SssdConfPath, AgentConfigPath} {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	runner := &leaveRunner{fail: map[string]bool{}}
	return Env{Root: root, Run: runner}, runner
}

func TestLeavingWithoutACredentialOrForceIsRefused(t *testing.T) {
	env, runner := joinedMachine(t)

	_, err := Leave(context.Background(), Options{Domain: "corp.example.internal"}, env, false)

	if err == nil {
		t.Fatal("a machine left the domain with neither a credential nor --force")
	}
	if len(runner.commands) != 0 {
		t.Fatalf("something ran anyway: %v", runner.commands)
	}
	// Nothing may be torn down by a refused request.
	if _, statErr := os.Stat(env.Path(KeytabPath)); statErr != nil {
		t.Error("the keytab was removed by a request that was refused")
	}
}

func TestLeavingWithACredentialRemovesTheAccountAndTheLocalState(t *testing.T) {
	env, runner := joinedMachine(t)

	result, err := Leave(context.Background(), Options{
		Domain:    "corp.example.internal",
		AdminUser: "Administrator",
		Password:  "secret",
	}, env, false)
	if err != nil {
		t.Fatal(err)
	}

	if !result.AccountRemoved {
		t.Error("the computer account was not reported as removed")
	}
	var left bool
	for _, command := range runner.commands {
		if command[0] == "net" && strings.Join(command, " ") == "net ads leave -U Administrator" {
			left = true
		}
	}
	if !left {
		t.Errorf("net ads leave never ran: %v", runner.commands)
	}
	for _, path := range []string{KeytabPath, SssdConfPath, AgentConfigPath} {
		if _, statErr := os.Stat(env.Path(path)); statErr == nil {
			t.Errorf("%s is still there", path)
		}
	}
}

func TestForceLeavesLocallyAndSaysTheAccountRemains(t *testing.T) {
	env, _ := joinedMachine(t)

	result, err := Leave(context.Background(), Options{Domain: "corp.example.internal"}, env, true)
	if err != nil {
		t.Fatal(err)
	}

	if result.AccountRemoved {
		t.Error("no credential was given, so no account can have been removed")
	}
	summary := result.Summary("corp.example.internal")
	if !strings.Contains(summary, "still in the directory") {
		t.Errorf("the summary does not say the account remains:\n%s", summary)
	}
	if _, statErr := os.Stat(env.Path(KeytabPath)); statErr == nil {
		t.Error("the keytab survived a forced leave")
	}
}

func TestADomainRefusalStopsTheLeaveUnlessForced(t *testing.T) {
	env, runner := joinedMachine(t)
	runner.fail["net"] = true

	_, err := Leave(context.Background(), Options{
		Domain:    "corp.example.internal",
		AdminUser: "helpdesk",
		Password:  "secret",
	}, env, false)

	if err == nil {
		t.Fatal("the domain refused the removal and the machine left anyway")
	}
	// An account that could not be removed must not leave a machine that
	// looks disconnected: the operator has to see the refusal.
	if _, statErr := os.Stat(env.Path(KeytabPath)); statErr != nil {
		t.Error("the keytab was removed even though the domain refused")
	}
}
