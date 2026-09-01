package tasks

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"odm.example.org/agent/internal/apply"
	"odm.example.org/agent/internal/inventory"
)

// Listing a directory is not something an agent used to be asked, because a
// round trip took a poll interval and typing the path was faster. The control
// plane now holds the request open until there is work, so a click costs about
// a second and the console can browse the machine the way an operator expects
// when choosing where a share lives.

// How many entries one listing returns. A directory with a hundred thousand
// files is not something to render, and the operator is choosing a folder.
const maxEntries = 500

func browse(_ context.Context, payload map[string]any, env apply.Env) (string, error) {
	path, err := absolute(str(payload["path"]))
	if err != nil {
		return "", err
	}

	full := env.Path(path)
	info, err := os.Stat(full)
	if err != nil {
		return "", fmt.Errorf("%s: %w", path, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a directory", path)
	}

	found, err := os.ReadDir(full)
	if err != nil {
		return "", fmt.Errorf("%s: %w", path, err)
	}

	type entry struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	// Directories only. The console is choosing a folder, and a list of every
	// file on a server is both useless here and more than it needs to know.
	entries := make([]entry, 0, len(found))
	for _, item := range found {
		if !item.IsDir() || strings.HasPrefix(item.Name(), ".") {
			continue
		}
		entries = append(entries, entry{Name: item.Name(), Path: filepath.Join(path, item.Name())})
	}
	sort.Slice(entries, func(a, b int) bool { return entries[a].Name < entries[b].Name })
	truncated := len(entries) > maxEntries
	if truncated {
		entries = entries[:maxEntries]
	}

	parent := filepath.Dir(path)
	if path == "/" {
		parent = ""
	}
	body, err := json.Marshal(map[string]any{
		"path":      path,
		"parent":    parent,
		"entries":   entries,
		"truncated": truncated,
	})
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// makeDirectory creates a folder the operator asked for while browsing, so a
// share can be put somewhere that does not exist yet without a terminal.
func makeDirectory(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	path, err := absolute(str(payload["path"]))
	if err != nil {
		return "", err
	}
	if path == "/" {
		return "", fmt.Errorf("/ already exists")
	}
	if err := os.MkdirAll(env.Path(path), 0o755); err != nil {
		return "", err
	}
	return browse(ctx, map[string]any{"path": filepath.Dir(path)}, env)
}

// absolute resolves what the console asked for. Cleaned rather than rejected
// for containing "..", so the path acted on is always the path reported back.
func absolute(path string) (string, error) {
	if path == "" {
		return "/", nil
	}
	if !strings.HasPrefix(path, "/") {
		return "", fmt.Errorf("%q is not an absolute path", path)
	}
	if strings.ContainsRune(path, 0) {
		return "", fmt.Errorf("invalid path")
	}
	return filepath.Clean(path), nil
}

// discoverPrinters asks CUPS what it can print to, now.
//
// The same list rides the check-in, but a print server that was installed a
// minute ago has not checked in yet — and an operator who has just plugged a
// printer in should not have to wait a quarter of an hour to see it. The scan
// is a real network sweep, so it is given longer than the one on the
// check-in but still bounded.
func discoverPrinters(ctx context.Context, env apply.Env) (string, error) {
	found := inventory.PrintDevices(ctx, env, 20)
	if found == nil {
		// json renders a nil slice as null, and "None found" is a list of
		// none, not the absence of one.
		found = []inventory.PrintDevice{}
	}
	body, err := json.Marshal(map[string]any{"devices": found})
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// takeDomainBackup asks samba-tool for a backup of this controller.
//
// Offline, because an online backup replicates the whole directory over
// DRSUAPI and needs rights close to a Domain Admin's. The agent is root on
// the controller, so it reads the database directly and needs nothing in the
// directory. Same reason the agent installs roles and the control plane does
// not.
func takeDomainBackup(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	target, err := absolute(str(payload["target_dir"]))
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(env.Path(target), 0o700); err != nil {
		return "", err
	}
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	out, err := env.Run.Run(ctx, "samba-tool", "domain", "backup", "offline",
		"--targetdir="+target)
	if err != nil {
		return out, fmt.Errorf("samba-tool domain backup: %w", err)
	}

	// The archive it just wrote, so the console can name it without guessing.
	entries, _ := os.ReadDir(env.Path(target))
	newest, when := "", int64(0)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "samba-backup-") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Unix() >= when {
			newest, when = filepath.Join(target, entry.Name()), info.ModTime().Unix()
		}
	}
	size := int64(0)
	if newest != "" {
		if info, err := os.Stat(env.Path(newest)); err == nil {
			size = info.Size()
		}
	}
	body, err := json.Marshal(map[string]any{"path": newest, "size_bytes": size, "output": out})
	if err != nil {
		return "", err
	}
	return string(body), nil
}
