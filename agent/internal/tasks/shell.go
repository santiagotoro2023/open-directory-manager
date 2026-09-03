package tasks

import (
	"context"
	"fmt"
	"os/exec"
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
// Not a terminal. There is no pty and no session: each command starts fresh,
// so a cd does not carry to the next one and anything that waits for input
// waits until the timeout. That is the shape the task queue can carry, and it
// covers what troubleshooting actually asks for.
//
// ponytail: one command per round trip, ~1s each via the held-open poll. A
// real interactive session needs a websocket between console and agent.

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

	// The machine's own shell, so what an operator types is what they would
	// have typed sitting at it — pipes, redirection and all.
	run := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	run.Dir = env.Path("/")
	// Nothing on stdin: a command that stops to ask a question would
	// otherwise hold the task open until its timeout with no way to answer.
	run.Stdin = nil
	out, err := run.CombinedOutput()

	text := string(out)
	if len(text) > maxShellOutput {
		text = "[earlier output dropped]\n" + text[len(text)-maxShellOutput:]
	}
	if ctx.Err() == context.DeadlineExceeded {
		return text, fmt.Errorf("still running after %ds; killed", seconds)
	}
	if err != nil {
		// The output is the answer even when the command failed — a non-zero
		// exit with a message on stderr is the normal way to learn something.
		return text, fmt.Errorf("%s", err)
	}
	if strings.TrimSpace(text) == "" {
		return "(no output)", nil
	}
	return text, nil
}
