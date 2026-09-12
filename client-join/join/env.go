package join

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Env is the machine the join writes to. Tests substitute a temporary root
// and a recording runner, so the whole sequence runs without a domain.
type Env struct {
	// Root is prefixed to every absolute path. "" on a real machine.
	Root string
	Run  Runner
}

// Runner executes host commands.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (string, error)
	// RunWithInput feeds stdin, so a password never appears in a command line.
	RunWithInput(ctx context.Context, stdin string, name string, args ...string) (string, error)
}

type execRunner struct{}

func (execRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	return execRunner{}.RunWithInput(ctx, "", name, args...)
}

func (execRunner) RunWithInput(
	ctx context.Context, stdin string, name string, args ...string,
) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("%s: %w: %s", name, err, reason(out, errOut))
	}
	return out.String(), nil
}

// reason is what the command said about its own failure.
//
// Both streams, because the one that matters depends on the command: net ads
// join prints "Failed to join domain: …" on standard output and leaves
// standard error empty, so an error built from stderr alone read
//
//	the domain refused the join: net: exit status 255:
//
// — a colon with nothing after it, over a command that had just said exactly
// what was wrong.
func reason(out, errOut bytes.Buffer) string {
	said := strings.TrimSpace(errOut.String())
	if printed := strings.TrimSpace(out.String()); printed != "" {
		if said != "" {
			said += "\n"
		}
		said += printed
	}
	if said == "" {
		return "it said nothing"
	}
	return lastLines(said, 8)
}

// lastLines keeps the end of some output, which is where a command says how
// it went. Samba's tools are verbose on the way to a failure.
func lastLines(text string, count int) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) <= count {
		return strings.Join(lines, "\n")
	}
	return strings.Join(lines[len(lines)-count:], "\n")
}

// NewEnv returns an Env writing to the real machine, or beneath root.
func NewEnv(root string) Env {
	return Env{Root: root, Run: execRunner{}}
}

func (e Env) Path(path string) string {
	if e.Root == "" {
		return path
	}
	return filepath.Join(e.Root, path)
}

// WriteFile writes atomically with the given mode.
func (e Env) WriteFile(path, content string, mode os.FileMode) error {
	full := e.Path(path)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(full), ".odm-join-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())

	if _, err := temp.WriteString(content); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(temp.Name(), mode); err != nil {
		return err
	}
	return os.Rename(temp.Name(), full)
}

// WriteFileIfMissing creates a file only when there is not one already, so a
// file server's own shares survive a rejoin.
func (e Env) WriteFileIfMissing(path, content string, mode os.FileMode) error {
	if _, err := os.Stat(e.Path(path)); err == nil {
		return nil
	}
	return e.WriteFile(path, content, mode)
}

// Backup keeps a copy of a file the join is about to replace.
func (e Env) Backup(path string) error {
	full := e.Path(path)
	body, err := os.ReadFile(full)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	return os.WriteFile(full+".pre-odm."+stamp, body, 0o600)
}
