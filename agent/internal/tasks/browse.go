package tasks

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

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
		Name      string `json:"name"`
		Path      string `json:"path"`
		Directory bool   `json:"directory"`
		Size      int64  `json:"size,omitempty"`
		Modified  string `json:"modified,omitempty"`
		// Who it belongs to and what they may do with it. Names where the
		// machine can resolve them, because a numeric id means nothing to
		// somebody reading a console on another machine.
		Owner string `json:"owner,omitempty"`
		Group string `json:"group,omitempty"`
		Mode  string `json:"mode,omitempty"`
	}
	// Directories only unless the caller asks for the files as well: choosing
	// where a share lives is a folder question, and looking at what is on a
	// machine is not. Names, sizes and times either way — never contents.
	withFiles := boolean(payload["files"], false)
	entries := make([]entry, 0, len(found))
	for _, item := range found {
		if strings.HasPrefix(item.Name(), ".") {
			continue
		}
		if !item.IsDir() && !withFiles {
			continue
		}
		record := entry{
			Name:      item.Name(),
			Path:      filepath.Join(path, item.Name()),
			Directory: item.IsDir(),
		}
		if info, err := item.Info(); err == nil {
			if !item.IsDir() {
				record.Size = info.Size()
			}
			record.Modified = info.ModTime().UTC().Format(time.RFC3339)
			record.Mode = fmt.Sprintf("%04o", info.Mode().Perm())
			record.Owner, record.Group = ownership(info)
		}
		entries = append(entries, record)
	}
	// Directories first, then files, each by name: the order somebody reading
	// a folder expects.
	sort.Slice(entries, func(a, b int) bool {
		if entries[a].Directory != entries[b].Directory {
			return entries[a].Directory
		}
		return entries[a].Name < entries[b].Name
	})
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

// ownership is who a file belongs to, by name where the machine knows one.
//
// Cached because a directory of five hundred files is five hundred lookups
// otherwise, and on a domain member each one can be an LDAP round trip.
func ownership(info os.FileInfo) (string, string) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", ""
	}
	return nameOf(&userNames, strconv.FormatUint(uint64(stat.Uid), 10), func(id string) string {
			if found, err := user.LookupId(id); err == nil {
				return found.Username
			}
			return id
		}),
		nameOf(&groupNames, strconv.FormatUint(uint64(stat.Gid), 10), func(id string) string {
			if found, err := user.LookupGroupId(id); err == nil {
				return found.Name
			}
			return id
		})
}

var (
	userNames  sync.Map
	groupNames sync.Map
)

func nameOf(cache *sync.Map, id string, lookup func(string) string) string {
	if cached, ok := cache.Load(id); ok {
		return cached.(string)
	}
	name := lookup(id)
	cache.Store(id, name)
	return name
}

// setPermissions changes who a path belongs to and what they may do with it.
//
// The whole point of browsing a machine's files from the console is to find
// the one whose rights are wrong; being told to open a terminal to fix it
// makes the browsing pointless. Root on the machine already, so this adds no
// power the console did not have — it makes an existing one usable.
func setPermissions(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	path, err := absolute(str(payload["path"]))
	if err != nil {
		return "", err
	}
	if path == "/" {
		return "", fmt.Errorf("/ is not something to change the ownership of")
	}
	full := env.Path(path)
	if _, err := os.Stat(full); err != nil {
		return "", fmt.Errorf("%s: %w", path, err)
	}

	owner := strings.TrimSpace(str(payload["owner"]))
	group := strings.TrimSpace(str(payload["group"]))
	mode := strings.TrimSpace(str(payload["mode"]))
	recursive := boolean(payload["recursive"], false)

	// Second pair of eyes on values that reach an argv as root. The control
	// plane checks them too; this process does not have to trust it.
	if owner != "" && !safeOwner.MatchString(owner) {
		return "", fmt.Errorf("invalid owner %q", owner)
	}
	if group != "" && !safeOwner.MatchString(group) {
		return "", fmt.Errorf("invalid group %q", group)
	}
	if mode != "" && !safeMode.MatchString(mode) {
		return "", fmt.Errorf("mode must be octal, for example 0750")
	}
	if owner == "" && group == "" && mode == "" {
		return "", fmt.Errorf("nothing to change")
	}
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}

	// chown and chmod rather than the syscalls: a name has to be resolved
	// through NSS to reach domain accounts, and these already do it the way
	// the rest of the machine does.
	if owner != "" || group != "" {
		args := []string{}
		if recursive {
			args = append(args, "-R")
		}
		args = append(args, owner+":"+group, full)
		if out, err := env.Run.Run(ctx, "chown", args...); err != nil {
			return out, fmt.Errorf("chown: %w", err)
		}
	}
	if mode != "" {
		args := []string{}
		if recursive {
			args = append(args, "-R")
		}
		args = append(args, mode, full)
		if out, err := env.Run.Run(ctx, "chmod", args...); err != nil {
			return out, fmt.Errorf("chmod: %w", err)
		}
	}
	// The listing it now has, so the console shows the result rather than
	// asking for it again.
	return browse(ctx, map[string]any{"path": filepath.Dir(path), "files": true}, env)
}

var (
	// A user or group name, or a numeric id. Empty is allowed by the caller
	// above, which is how "change the group and leave the owner alone" is
	// said to chown.
	safeOwner = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._$@ -]{0,127}$`)
	safeMode  = regexp.MustCompile(`^0?[0-7]{3}$`)
)

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
