package shell

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// drain collects everything the session sends until it says the shell has
// exited, or the deadline passes.
func drain(t *testing.T, pipe *Pipe, until time.Duration) (output string, exit *control) {
	t.Helper()
	deadline := time.After(until)
	var text strings.Builder
	for {
		select {
		case message := <-pipe.Out:
			if len(message) == 0 {
				continue
			}
			if message[0] == FrameControl {
				var c control
				if json.Unmarshal(message[1:], &c) == nil && c.Type == "exit" {
					return text.String(), &c
				}
				continue
			}
			text.Write(message[1:])
		case <-deadline:
			return text.String(), nil
		}
	}
}

func direct() Options {
	no := false
	return Options{Cols: 80, Rows: 24, Command: []string{"/bin/sh"}, Systemd: &no}
}

func TestWhatIsTypedRunsAndWhatItPrintsComesBack(t *testing.T) {
	if _, err := os.Stat("/dev/ptmx"); err != nil {
		t.Skip("no pseudo-terminals here")
	}
	pipe := NewPipe()
	done := make(chan error, 1)
	go func() { done <- Serve(context.Background(), pipe, direct()) }()

	pipe.In <- append([]byte{FrameData}, "echo hello-from-a-pty; exit 3\n"...)
	output, exit := drain(t, pipe, 10*time.Second)
	if !strings.Contains(output, "hello-from-a-pty") {
		t.Errorf("the shell's output never arrived:\n%q", output)
	}
	if exit == nil || exit.Status != 3 {
		t.Errorf("the shell's exit status was not reported: %+v", exit)
	}
	if err := <-done; err != nil {
		t.Errorf("a shell that exited on its own is not a failure: %v", err)
	}
}

func TestTheTerminalIsTheSizeTheConsoleSays(t *testing.T) {
	if _, err := os.Stat("/dev/ptmx"); err != nil {
		t.Skip("no pseudo-terminals here")
	}
	pipe := NewPipe()
	go func() { _ = Serve(context.Background(), pipe, direct()) }()

	// It is a terminal, so a program asking how big it is gets an answer —
	// which is what a pager or an editor needs, and what the one-shot shell
	// could never give.
	resize, _ := json.Marshal(control{Type: "resize", Cols: 132, Rows: 43})
	pipe.In <- append([]byte{FrameControl}, resize...)
	pipe.In <- append([]byte{FrameData}, "stty size; exit\n"...)
	output, exit := drain(t, pipe, 10*time.Second)
	if !strings.Contains(output, "43 132") {
		t.Errorf("the resize never reached the terminal:\n%q", output)
	}
	if exit == nil {
		t.Error("the shell never reported exiting")
	}
}

func TestAConsoleThatGoesAwayHangsUpTheShell(t *testing.T) {
	if _, err := os.Stat("/dev/ptmx"); err != nil {
		t.Skip("no pseudo-terminals here")
	}
	pipe := NewPipe()
	done := make(chan error, 1)
	go func() { done <- Serve(context.Background(), pipe, direct()) }()

	// Something long-running, then the browser tab closes.
	pipe.In <- append([]byte{FrameData}, "sleep 300\n"...)
	time.Sleep(300 * time.Millisecond)
	pipe.Close()

	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "console went away") {
			t.Errorf("the reason the session ended is not the real one: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the shell kept running after the console had gone")
	}
}
