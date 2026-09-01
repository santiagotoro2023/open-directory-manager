package tasks

import (
	"bufio"
	"context"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Installing a role is minutes of apt with nothing on screen but the word
// "installing", which cannot be told apart from a hang. These commands report
// what they have printed so far while they are still running, so the console
// can show the machine's own output rather than a spinner.

// Progress receives everything the command has printed so far. Called from
// the goroutine reading the pipe, no more often than progressEvery.
type Progress func(output string)

const progressEvery = 4 * time.Second

// How much of a long install is kept. apt prints thousands of lines; the last
// few hundred are the ones worth looking at, and the whole thing has to fit
// in one request and one database column.
const keepBytes = 60_000

// stream runs a command, reporting its output as it arrives.
//
// Kept separate from the shared Runner deliberately: that one takes no
// callback and buffers everything, which is right for the short commands and
// is what the tests substitute.
func stream(
	ctx context.Context, progress Progress, name string, args ...string,
) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	pipe, err := command.StdoutPipe()
	if err != nil {
		return "", err
	}
	command.Stderr = command.Stdout
	if err := command.Start(); err != nil {
		return "", err
	}

	var guard sync.Mutex
	var seen strings.Builder
	last := time.Now()

	reader := bufio.NewScanner(pipe)
	// A line of apt output can be long; the default 64K token limit turns a
	// long one into an error that ends the read early.
	reader.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for reader.Scan() {
		guard.Lock()
		seen.WriteString(reader.Text())
		seen.WriteByte('\n')
		text := seen.String()
		guard.Unlock()
		if progress != nil && time.Since(last) >= progressEvery {
			last = time.Now()
			progress(tail(text))
		}
	}
	if err := reader.Err(); err != nil && err != io.EOF {
		seen.WriteString("\n(reading the command's output: " + err.Error() + ")\n")
	}

	waitErr := command.Wait()
	return tail(seen.String()), waitErr
}

func tail(text string) string {
	if len(text) <= keepBytes {
		return text
	}
	cut := text[len(text)-keepBytes:]
	// Start at a line boundary rather than mid-word.
	if index := strings.IndexByte(cut, '\n'); index >= 0 {
		cut = cut[index+1:]
	}
	return "(earlier output trimmed)\n" + cut
}
