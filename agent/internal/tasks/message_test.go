package tasks

import (
	"context"
	"strings"
	"testing"

	"odm.example.org/agent/internal/apply"
)

// sessionsRunner answers loginctl the way a machine with two desktops does.
type sessionsRunner struct{ calls [][]string }

func (r *sessionsRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	r.calls = append(r.calls, append([]string{name}, args...))
	if name == "loginctl" && args[0] == "list-sessions" {
		return "3 1000 alice seat0 tty2\n7 1001 bob - -\n9 0 root - pts/0\n", nil
	}
	if name == "loginctl" && args[0] == "show-session" {
		if args[1] == "7" {
			return "Type=x11\nDisplay=:1\n", nil
		}
		return "Type=wayland\nDisplay=\n", nil
	}
	return "", nil
}

func TestAMessageReachesEveryDesktopAndTheTerminals(t *testing.T) {
	run := &sessionsRunner{}
	env := apply.Env{Root: t.TempDir(), Run: run}
	out, err := sendMessage(context.Background(), map[string]any{
		"title": "Maintenance", "text": "The file server restarts at 18:00.", "urgency": "critical",
	}, env)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "shown to 2") {
		t.Fatalf("summary: %q", out)
	}
	notified, walled := 0, false
	for _, call := range run.calls {
		line := strings.Join(call, " ")
		if call[0] == "systemd-run" && strings.Contains(line, "notify-send") {
			notified++
			if !strings.Contains(line, "--urgency=critical") || !strings.Contains(line, "The file server restarts") {
				t.Errorf("notification lacks the message or its urgency: %s", line)
			}
			if !strings.Contains(line, "--uid 1000") && !strings.Contains(line, "--uid 1001") {
				t.Errorf("notification not shown as the person: %s", line)
			}
		}
		if call[0] == "wall" {
			walled = true
		}
	}
	if notified != 2 {
		t.Errorf("%d notifications for two desktops (root's pts is not one)", notified)
	}
	if !walled {
		t.Error("the terminals never heard")
	}
}

func TestAnEmptyMessageIsRefused(t *testing.T) {
	env := apply.Env{Root: t.TempDir(), Run: &sessionsRunner{}}
	if _, err := sendMessage(context.Background(), map[string]any{"text": "  "}, env); err == nil {
		t.Fatal("an empty message was sent")
	}
}
