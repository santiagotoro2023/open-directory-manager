package tasks

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"odm.example.org/agent/internal/apply"
)

// A command, run on this machine, for somebody troubleshooting it from the
// console.
//
// This is root on this machine, and it is deliberately not narrowed into
// something smaller: an operator who cannot run what they need to run signs
// in to the machine instead, and then nothing is recorded at all. What makes
// it safe to have is on the other side — its own right, checked against this
// machine's object, and an audit entry carrying the command, who ran it and
// what came back.
//
// Each command is its own process, so nothing survives between them except
// the working directory, which is carried back and forth: cd works, and a
// variable exported in one command is gone in the next. Nothing reads stdin,
// so a command that stops to ask a question waits for its timeout instead of
// hanging for ever.
//
// ponytail: one command per round trip, ~1s each via the held-open poll, and
// no pty — no job control, no curses program, no interactive prompt. A real
// terminal needs a websocket between console and agent; this covers what
// troubleshooting a machine actually asks for.

// What comes back. A command that prints a kernel log is not something to
// carry in a JSON field or render in a browser.
const maxShellOutput = 200_000

func runShell(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	command := strings.TrimSpace(str(payload["command"]))
	if command == "" {
		return "", fmt.Errorf("no command")
	}
	seconds := intOf(payload["timeout_seconds"], 60)
	if seconds < 1 || seconds > 600 {
		seconds = 60
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()

	cwd := str(payload["cwd"])
	if cwd == "" || !strings.HasPrefix(cwd, "/") {
		cwd = "/"
	}

	// Where the shell says it ended up, kept out of the output rather than
	// printed into it: a marker in the text would be indistinguishable from a
	// command that printed the same thing.
	marker, err := os.CreateTemp("", "odm-shell-cwd")
	if err != nil {
		return "", err
	}
	defer os.Remove(marker.Name())
	marker.Close()

	// The machine's own shell, so what an operator types is what they would
	// have typed sitting at it — pipes, redirection, background jobs and all.
	// eval rather than -c on the command itself, so the working directory can
	// be set first and read back afterwards without either being pasted into
	// what the operator wrote.
	const script = `cd -- "$1" 2>/dev/null || cd /
shift
eval "$1"
__odm_status=$?
printf '%s' "$PWD" > "$2"
exit $__odm_status`
	run := exec.CommandContext(ctx, "/bin/sh", "-c", script, "sh",
		env.Path(cwd), command, marker.Name())
	// Nothing on stdin: a command that stops to ask a question would
	// otherwise hold the task open until its timeout with no way to answer.
	run.Stdin = nil
	out, runErr := run.CombinedOutput()

	text := string(out)
	if len(text) > maxShellOutput {
		text = "[earlier output dropped]\n" + text[len(text)-maxShellOutput:]
	}

	ended := cwd
	if raw, err := os.ReadFile(marker.Name()); err == nil && strings.HasPrefix(string(raw), "/") {
		ended = strings.TrimPrefix(filepath.Clean(string(raw)), strings.TrimSuffix(env.Path("/"), "/"))
		if ended == "" {
			ended = "/"
		}
	}

	body, err := json.Marshal(map[string]any{"output": text, "cwd": ended})
	if err != nil {
		return "", err
	}
	if ctx.Err() == context.DeadlineExceeded {
		return string(body), fmt.Errorf("still running after %ds; killed", seconds)
	}
	if runErr != nil {
		// The output is the answer even when the command failed — a non-zero
		// exit with a message on stderr is the normal way to learn something.
		return string(body), fmt.Errorf("%s", runErr)
	}
	return string(body), nil
}
