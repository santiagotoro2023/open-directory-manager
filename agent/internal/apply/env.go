// Package apply turns an effective-policy document into changes on the
// machine, and reports what happened to each setting.
//
// Every applier writes through Env, so the whole package is testable against
// a temporary directory and a fake command runner rather than a live host.
package apply

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Header goes at the top of every file the agent owns, so an operator who
// finds one knows why it is there and that edits will be overwritten.
const Header = "# Managed by Open Directory Manager. Local edits are overwritten.\n"

// Runner executes host commands. Swapped out in tests.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (string, error)
}

type execRunner struct{}

func (execRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(errOut.String()))
	}
	return out.String(), nil
}

// Env is the machine an applier writes to.
type Env struct {
	// Session marks a pass applied for one person signing in rather than for
	// the machine. What each pass created is recorded separately: with one
	// record between them, the machine's next pass removed the printer and
	// unmounted the drive the login had just set up.
	Session bool
	// Root is prefixed to every absolute path. "" on a real host, a
	// temporary directory in tests.
	Root string
	Run  Runner
	// State records the paths this run owns, so files a policy no longer
	// contains are removed on the next run.
	State *State
}

func NewEnv(root string) Env {
	return Env{Root: root, Run: execRunner{}, State: NewState()}
}

// NewSessionEnv is the same machine, for work done on behalf of one person
// signing in: their drive maps, their connection files, their profile.
func NewSessionEnv(root string) Env {
	env := NewEnv(root)
	env.Session = true
	return env
}

func (e Env) Path(path string) string {
	if e.Root == "" {
		return path
	}
	return filepath.Join(e.Root, path)
}

// WriteFile writes atomically: a temporary file in the same directory,
// then a rename, so a reader never sees a half-written policy file.
func (e Env) WriteFile(path, content string, mode os.FileMode, owner, group string) error {
	full := e.Path(path)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(full), ".odm-*")
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
	if e.Root == "" && (owner != "" || group != "") {
		if err := chown(temp.Name(), owner, group); err != nil {
			return err
		}
	}
	if err := os.Rename(temp.Name(), full); err != nil {
		return err
	}
	e.State.Own(path)
	return nil
}

func chown(path, owner, group string) error {
	uid, gid := -1, -1
	if owner != "" {
		u, err := user.Lookup(owner)
		if err != nil {
			return fmt.Errorf("owner %q: %w", owner, err)
		}
		uid, _ = strconv.Atoi(u.Uid)
	}
	if group != "" {
		g, err := user.LookupGroup(group)
		if err != nil {
			return fmt.Errorf("group %q: %w", group, err)
		}
		gid, _ = strconv.Atoi(g.Gid)
	}
	return os.Chown(path, uid, gid)
}

func ParseMode(mode string, fallback os.FileMode) os.FileMode {
	if mode == "" {
		return fallback
	}
	parsed, err := strconv.ParseUint(mode, 8, 32)
	if err != nil {
		return fallback
	}
	return os.FileMode(parsed)
}

// State tracks which paths the agent owns between runs so that removing a
// setting from a GPO actually removes the file it produced.
type State struct {
	Owned map[string]bool `json:"owned"`
	// Files ODM did not create and only keeps a block inside: PAM stacks,
	// sshd's configuration, nsswitch. Pruning one of these means taking the
	// block back out, never deleting the file — deleting
	// /etc/pam.d/common-account because a policy stopped mentioning it takes
	// authentication off the machine entirely.
	Blocks map[string]bool `json:"blocks,omitempty"`
}

func NewState() *State {
	return &State{Owned: map[string]bool{}, Blocks: map[string]bool{}}
}

func (s *State) Own(path string) {
	if s != nil {
		s.Owned[path] = true
	}
}

// OwnBlock records a file ODM edits but does not own.
func (s *State) OwnBlock(path string) {
	if s == nil {
		return
	}
	if s.Blocks == nil {
		s.Blocks = map[string]bool{}
	}
	s.Blocks[path] = true
	// A file cannot be both; the block wins, because it is the safer of the
	// two and ReplaceBlock is what wrote it.
	delete(s.Owned, path)
}

// SortedBlocks returns block-owned paths in a stable order.
func (s *State) SortedBlocks() []string {
	paths := make([]string, 0, len(s.Blocks))
	for path := range s.Blocks {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

// Sorted returns owned paths in a stable order.
func (s *State) Sorted() []string {
	paths := make([]string, 0, len(s.Owned))
	for path := range s.Owned {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

// Prune deletes files owned by the previous run that this run did not
// rewrite, so a policy removal takes effect instead of lingering forever.
func (e Env) Prune(previous *State) []string {
	var removed []string
	if previous == nil {
		return removed
	}
	for _, path := range previous.Sorted() {
		if e.State.Owned[path] || e.State.Blocks[path] {
			continue
		}
		if err := os.Remove(e.Path(path)); err == nil {
			removed = append(removed, path)
		}
	}
	// A file ODM only kept a block inside belongs to the system. Take the
	// block out and leave the file.
	for _, path := range previous.SortedBlocks() {
		if e.State.Blocks[path] || e.State.Owned[path] {
			continue
		}
		if err := e.ReplaceBlock(path, "", 0o644); err == nil {
			removed = append(removed, path+" (block)")
		}
	}
	return removed
}
