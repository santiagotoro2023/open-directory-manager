package tasks

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"odm.example.org/agent/internal/apply"
)

func TestTheX11ServerListensOnLoopbackOnlyAndOutlivesOneViewer(t *testing.T) {
	if _, err := exec.LookPath("x11vnc"); err != nil {
		// shareX11 installs it when missing, through apt, which is not for
		// a test; a fake binary on PATH satisfies the lookup.
		dir := t.TempDir()
		if err := os.WriteFile(dir+"/x11vnc", []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	}
	run := &recorder{}
	env := apply.Env{Root: t.TempDir(), Run: run}
	session := assistSession{user: "alice", uid: 1000, kind: "x11", display: ":1"}
	if err := shareX11(context.Background(), env, session, "s3cret", 45); err != nil {
		t.Fatal(err)
	}
	var started []string
	for _, call := range run.calls {
		if call[0] == "systemd-run" {
			started = call
		}
	}
	if started == nil {
		t.Fatalf("x11vnc was not started: %v", run.calls)
	}
	line := strings.Join(started, " ")
	for _, want := range []string{"-localhost", "-forever", "-shared", "-rfbport 5900", "RuntimeMaxSec=2700", "-passwd s3cret"} {
		if !strings.Contains(line, want) {
			t.Errorf("x11vnc line lacks %q: %s", want, line)
		}
	}
	if strings.Contains(line, "-once") {
		t.Errorf("one viewer must not end the offer: %s", line)
	}
	if run.calls[0][0] != "systemctl" || run.calls[0][1] != "stop" {
		t.Errorf("a previous offer's unit is stopped first: %v", run.calls[0])
	}
}

func TestAssistRelayOnlyForAVNCAnswerWithASession(t *testing.T) {
	session, address, until, ok := AssistRelay(map[string]any{"session": "abc"}, "vnc 5900 - pw 30")
	if !ok || session != "abc" || address != "127.0.0.1:5900" {
		t.Fatalf("got %q %q %v", session, address, ok)
	}
	if left := time.Until(until); left < 29*time.Minute || left > 31*time.Minute {
		t.Fatalf("offer length: %v", left)
	}
	if _, _, _, ok := AssistRelay(map[string]any{"session": "abc"}, "rdp 3389 odm-assist pw 30"); ok {
		t.Fatal("an RDP offer is reached directly, not relayed")
	}
	if _, _, _, ok := AssistRelay(map[string]any{}, "vnc 5900 - pw 30"); ok {
		t.Fatal("an offer the console did not name cannot be relayed")
	}
}
