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
