package tasks

import (
	"context"
	"strings"
	"testing"

	"odm.example.org/agent/internal/apply"
)

type recorder struct{ calls [][]string }

func (r *recorder) Run(_ context.Context, name string, args ...string) (string, error) {
	r.calls = append(r.calls, append([]string{name}, args...))
	return "", nil
}

func TestAddLocalUserRefusesANameTheShellWouldReadDifferently(t *testing.T) {
	env := apply.Env{Root: t.TempDir(), Run: &recorder{}}
	for _, name := range []string{"root; rm -rf /", "Alex", "", "../etc", "a b"} {
		if _, err := addLocalUser(context.Background(), map[string]any{"name": name}, env); err == nil {
			t.Fatalf("accepted %q as a login name", name)
		}
	}
}

func TestAddLocalUserLocksAnAccountGivenNoPassword(t *testing.T) {
	run := &recorder{}
	env := apply.Env{Root: t.TempDir(), Run: run}
	out, err := addLocalUser(context.Background(), map[string]any{
		"name":   "odm-test-account",
		"groups": []any{"sudo"},
	}, env)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "locked") {
		t.Fatalf("did not say the account was locked: %q", out)
	}
	if len(run.calls) != 2 || run.calls[0][0] != "useradd" || run.calls[1][0] != "passwd" {
		t.Fatalf("unexpected commands: %v", run.calls)
	}
	if !strings.Contains(strings.Join(run.calls[0], " "), "--groups sudo") {
		t.Fatalf("groups were not passed: %v", run.calls[0])
	}
}

// Removing a system account from a console that lists every account is a very
// short path to a machine that will not boot.
func TestRemoveLocalUserRefusesASystemAccount(t *testing.T) {
	env := apply.Env{Root: t.TempDir(), Run: &recorder{}}
	_, err := removeLocalUser(context.Background(), map[string]any{"name": "root"}, env)
	if err == nil || !strings.Contains(err.Error(), "system account") {
		t.Fatalf("root was not refused: %v", err)
	}
}
