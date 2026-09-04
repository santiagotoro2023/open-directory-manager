package tasks

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"odm.example.org/agent/internal/apply"
)

func run(t *testing.T, env apply.Env, command, cwd string) (string, string, error) {
	t.Helper()
	out, err := runShell(context.Background(), map[string]any{
		"command": command, "cwd": cwd, "timeout_seconds": 20,
	}, env)
	var answer struct {
		Output string `json:"output"`
		Cwd    string `json:"cwd"`
	}
	if jsonErr := json.Unmarshal([]byte(out), &answer); jsonErr != nil {
		t.Fatalf("the agent did not answer with JSON: %v (%q)", jsonErr, out)
	}
	return answer.Output, answer.Cwd, err
}

func TestTheShellKeepsTheDirectoryACommandEndedIn(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "srv", "shared"), 0o755); err != nil {
		t.Fatal(err)
	}
	env := apply.Env{Root: root}

	out, cwd, err := run(t, env, "cd srv/shared && pwd", "/")
	if err != nil {
		t.Fatal(err)
	}
	if cwd != "/srv/shared" {
		t.Errorf("ended in %q, wanted /srv/shared", cwd)
	}
	if !strings.Contains(out, "/srv/shared") {
		t.Errorf("pwd printed %q", out)
	}

	// And the next command starts there.
	_, cwd, err = run(t, env, "pwd", cwd)
	if err != nil || cwd != "/srv/shared" {
		t.Errorf("the directory did not carry over: %q, %v", cwd, err)
	}
}

func TestACommandThatFailsStillHandsBackItsOutputAndItsDirectory(t *testing.T) {
	// A non-zero exit is the ordinary answer at a prompt, and losing what it
	// printed makes the shell useless for exactly the commands somebody runs
	// to find out what is wrong.
	env := apply.Env{Root: t.TempDir()}
	out, cwd, err := run(t, env, "echo trouble >&2; exit 3", "/")
	if err == nil {
		t.Error("a non-zero exit was reported as success")
	}
	if !strings.Contains(out, "trouble") {
		t.Errorf("stderr was lost: %q", out)
	}
	if cwd != "/" {
		t.Errorf("the directory was lost: %q", cwd)
	}
}

func TestTheCommandIsRunByTheMachinesOwnShellRatherThanBeingParsedHere(t *testing.T) {
	// Pipes, quoting and redirection are what somebody would have typed
	// sitting at the machine, so they have to survive the round trip.
	env := apply.Env{Root: t.TempDir()}
	out, _, err := run(t, env, `printf 'a\nb\n' | grep -c . ; echo "it's fine"`, "/")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "2") || !strings.Contains(out, "it's fine") {
		t.Errorf("the shell did not run the command as written: %q", out)
	}
}

func TestAnEmptyCommandIsRefusedRatherThanRunningAShellForNothing(t *testing.T) {
	env := apply.Env{Root: t.TempDir()}
	if _, err := runShell(context.Background(), map[string]any{"command": "  "}, env); err == nil {
		t.Error("an empty command was accepted")
	}
}
