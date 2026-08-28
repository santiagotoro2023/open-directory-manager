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
		return out.String(), fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(errOut.String()))
	}
	return out.String(), nil
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
