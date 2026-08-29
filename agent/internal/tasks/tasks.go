// Package tasks runs the work the control plane queues for this machine.
//
// The control plane can only run a subprocess on its own host, so anything it
// needs done on a member server — installing a role, rendering a file share —
// arrives here instead. The agent is already root and already proves which
// machine it is, so it is the right thing to do the work (CLAUDE.md §5.5).
package tasks

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"odm.example.org/agent/internal/apply"
	"odm.example.org/agent/internal/inventory"
)

// Where install-agent.sh puts the role installers it ships alongside the agent.
const RoleDir = "/usr/lib/odm/roles"

// SharesConf is included from smb.conf; every ODM-managed share lives here and
// nothing else does, so the file can be rewritten wholesale.
const SharesConf = "/etc/samba/odm-shares.conf"

const managed = "# Managed by Open Directory Manager. Edits here are overwritten.\n"

// Task is one unit of queued work.
type Task struct {
	ID      string         `json:"id"`
	Kind    string         `json:"kind"`
	Payload map[string]any `json:"payload"`
}

// Result is what the control plane records against it.
type Result struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Output string `json:"output"`
}

// Names that reach a config file or an argv. Deliberately narrow: the control
// plane validates too, but this process is root and does not have to trust it.
var (
	safeRole  = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)
	safeName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._ -]{0,62}$`)
	safePath  = regexp.MustCompile(`^/[A-Za-z0-9._/-]{1,255}$`)
	safeEntry = regexp.MustCompile(`^d?:?[ugom]:[A-Za-z0-9._$ -]*:[rwx-]{3}$`)
	safeArg   = regexp.MustCompile(`^[A-Za-z0-9@:/._=-]{1,253}$`)
)

// Run performs one task and reports how it went. A task that fails is
// reported, never retried silently: an operator watching the console should
// see the reason rather than a spinner.
func Run(ctx context.Context, task Task, env apply.Env) Result {
	var output string
	var err error

	switch task.Kind {
	case "role-install":
		output, err = installRole(ctx, task.Payload, env)
	case "share-apply":
		output, err = applyShare(ctx, task.Payload, env)
	case "share-remove":
		output, err = removeShare(ctx, task.Payload, env)
	case "update-check":
		output, err = checkUpdates(ctx, env)
	case "update-install":
		output, err = installUpdates(ctx, env)
	case "package-install":
		output, err = changePackage(ctx, task.Payload, env, true)
	case "package-remove":
		output, err = changePackage(ctx, task.Payload, env, false)
	case "policy-refresh":
		// Nothing to do: fetching this task means a run is already under way,
		// and it is that run which re-applies the policy.
		output = "policy re-applied on this run"
	case "restart":
		output, err = power(ctx, env, "reboot")
	case "shutdown":
		output, err = power(ctx, env, "poweroff")
	default:
		err = fmt.Errorf("unknown task kind %q", task.Kind)
	}

	if err != nil {
		return Result{ID: task.ID, OK: false, Output: strings.TrimSpace(output + "\n" + err.Error())}
	}
	return Result{ID: task.ID, OK: true, Output: strings.TrimSpace(output)}
}

func installRole(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	role, _ := payload["role"].(string)
	if !safeRole.MatchString(role) {
		return "", fmt.Errorf("invalid role name %q", role)
	}
	arguments, err := stringList(payload["arguments"], safeArg)
	if err != nil {
		return "", err
	}

	installer := env.Path(filepath.Join(RoleDir, "install-"+role+"-role.sh"))
	if _, err := os.Stat(installer); err != nil {
		return "", fmt.Errorf(
			"%s is not installed on this machine; reinstall the agent package to get the "+
				"role installers", installer,
		)
	}
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	return env.Run.Run(ctx, installer, arguments...)
}

// checkUpdates refreshes the package index and reports what an upgrade would
// do. It changes nothing: the count it produces is what the console shows
// before an operator decides.
func checkUpdates(ctx context.Context, env apply.Env) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	if out, err := env.Run.Run(ctx, "apt-get", "update", "-qq"); err != nil {
		return out, fmt.Errorf("refreshing the package index: %w", err)
	}
	pending, security, names := inventory.PendingUpdates(ctx, env)
	if pending == 0 {
		return "everything is up to date", nil
	}
	return fmt.Sprintf(
		"%d updates waiting (%d from security): %s",
		pending, security, strings.Join(names, ", "),
	), nil
}

// installUpdates is the equivalent of apt update && apt upgrade -y, held to
// packages already installed: an upgrade never pulls in something new, and
// never answers a configuration-file prompt on an operator's behalf.
func installUpdates(ctx context.Context, env apply.Env) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	if out, err := env.Run.Run(ctx, "apt-get", "update", "-qq"); err != nil {
		return out, fmt.Errorf("refreshing the package index: %w", err)
	}
	out, err := env.Run.Run(ctx,
		"apt-get", "upgrade", "-y",
		"-o", "Dpkg::Options::=--force-confold",
		"-o", "Dpkg::Options::=--force-confdef",
	)
	if err != nil {
		return out, fmt.Errorf("upgrading: %w", err)
	}
	pending, _, _ := inventory.PendingUpdates(ctx, env)
	return fmt.Sprintf("%s\n%d updates still waiting", strings.TrimSpace(out), pending), nil
}

// Package names as the Debian archive defines them. Checked here as well as in
// the control plane: this process is root, and hands the value to apt.
var safePackage = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]{1,127}$`)

// Packages ODM will not take off a machine it manages, because doing so takes
// the machine out of the domain or takes the agent off it.
var keepInstalled = map[string]bool{
	"odm-agent": true, "sssd": true, "sssd-ad": true, "krb5-user": true,
	"systemd": true, "apt": true, "dpkg": true, "libc6": true, "sudo": true,
	"openssh-server": true, "samba-common": true, "realmd": true, "adcli": true,
}

func changePackage(
	ctx context.Context, payload map[string]any, env apply.Env, install bool,
) (string, error) {
	name := str(payload["package"])
	if !safePackage.MatchString(name) {
		return "", fmt.Errorf("invalid package name %q", name)
	}
	if !install && keepInstalled[name] {
		return "", fmt.Errorf(
			"%s is what keeps this machine joined and managed; removing it from here "+
				"would leave nothing to undo it with", name,
		)
	}
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}

	if install {
		if out, err := env.Run.Run(ctx, "apt-get", "update", "-qq"); err != nil {
			return out, fmt.Errorf("refreshing the package index: %w", err)
		}
	}
	action := "install"
	if !install {
		// purge would take the configuration with it, which is not what
		// "uninstall" means to someone reading a button.
		action = "remove"
	}
	out, err := env.Run.Run(ctx,
		"apt-get", action, "-y",
		"-o", "Dpkg::Options::=--force-confold",
		"-o", "Dpkg::Options::=--force-confdef",
		"--no-install-recommends", name,
	)
	if err != nil {
		return out, fmt.Errorf("apt-get %s %s: %w", action, name, err)
	}
	return fmt.Sprintf("%s %sed", name, action), nil
}

// power schedules the action a minute out and reports before it happens: a
// machine that reboots mid-request never gets to say that it worked.
func power(ctx context.Context, env apply.Env, action string) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	if out, err := env.Run.Run(ctx, "shutdown", flagFor(action), "+1",
		"Scheduled by Open Directory Manager"); err != nil {
		return out, fmt.Errorf("scheduling %s: %w", action, err)
	}
	return action + " scheduled in one minute", nil
}

func flagFor(action string) string {
	if action == "reboot" {
		return "-r"
	}
	return "-h"
}

// Share is the definition the control plane stores, as the agent receives it.
type Share struct {
	Name       string
	Path       string
	Comment    string
	Owner      string
	Group      string
	Browseable bool
	ReadOnly   bool
	ACL        []string
}

func parseShare(payload map[string]any) (Share, error) {
	share := Share{
		Name:       str(payload["name"]),
		Path:       str(payload["path"]),
		Comment:    str(payload["comment"]),
		Owner:      str(payload["owner"]),
		Group:      str(payload["group"]),
		Browseable: boolean(payload["browseable"], true),
		ReadOnly:   boolean(payload["read_only"], false),
	}
	if !safeName.MatchString(share.Name) {
		return share, fmt.Errorf("invalid share name %q", share.Name)
	}
	if !safePath.MatchString(share.Path) || strings.Contains(share.Path, "..") {
		return share, fmt.Errorf("invalid share path %q", share.Path)
	}
	if err := refuseSystemPath(share.Path); err != nil {
		return share, err
	}
	acl, err := stringList(payload["acl"], safeEntry)
	if err != nil {
		return share, err
	}
	share.ACL = acl
	return share, nil
}

func applyShare(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	share, err := parseShare(payload)
	if err != nil {
		return "", err
	}
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	var log strings.Builder

	full := env.Path(share.Path)
	// setgid, so files created in the share inherit its owning group whatever
	// the creator's own primary group is.
	if err := os.MkdirAll(full, 0o2770); err != nil {
		return log.String(), fmt.Errorf("creating %s: %w", share.Path, err)
	}
	fmt.Fprintf(&log, "directory %s ready\n", share.Path)

	if share.Owner != "" && share.Group != "" {
		if out, err := env.Run.Run(ctx, "chown", share.Owner+":"+share.Group, full); err != nil {
			return log.String(), fmt.Errorf("chown %s: %w: %s", share.Path, err, out)
		}
	}

	// Replace the access list rather than adding to it: what the console shows
	// has to be what the directory enforces, with nothing left over from a
	// previous version of the share.
	if out, err := env.Run.Run(ctx, "setfacl", "-b", full); err != nil {
		return log.String(), fmt.Errorf("clearing the access list: %w: %s", err, out)
	}
	if len(share.ACL) > 0 {
		args := append([]string{"-m", strings.Join(share.ACL, ",")}, full)
		if out, err := env.Run.Run(ctx, "setfacl", args...); err != nil {
			return log.String(), fmt.Errorf("setting the access list: %w: %s", err, out)
		}
		fmt.Fprintf(&log, "%d access entries applied\n", len(share.ACL))
	}

	if err := writeShares(ctx, share, env, false); err != nil {
		return log.String(), err
	}
	fmt.Fprintf(&log, "//%s/%s is shared", hostname(), share.Name)
	return log.String(), nil
}

func removeShare(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	name := str(payload["name"])
	if !safeName.MatchString(name) {
		return "", fmt.Errorf("invalid share name %q", name)
	}
	if err := writeShares(ctx, Share{Name: name}, env, true); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s is no longer shared; its contents are untouched", name), nil
}

// writeShares rewrites the managed include with this share added or removed,
// leaving every other managed share as it was.
func writeShares(ctx context.Context, share Share, env apply.Env, remove bool) error {
	path := env.Path(SharesConf)
	sections := map[string]string{}
	if raw, err := os.ReadFile(path); err == nil {
		sections = parseSections(string(raw))
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("reading %s: %w", SharesConf, err)
	}

	if remove {
		delete(sections, share.Name)
	} else {
		sections[share.Name] = renderShare(share)
	}

	names := make([]string, 0, len(sections))
	for name := range sections {
		names = append(names, name)
	}
	sort.Strings(names)

	body := managed
	for _, name := range names {
		body += "\n" + sections[name]
	}
	if err := env.WriteFile(SharesConf, body, 0o644, "root", "root"); err != nil {
		return fmt.Errorf("writing %s: %w", SharesConf, err)
	}

	if err := includeShares(env); err != nil {
		return err
	}
	// A share nobody can see is not a share. Reloading is cheap and idempotent.
	if env.Run != nil {
		_, _ = env.Run.Run(ctx, "smbcontrol", "smbd", "reload-config")
	}
	return nil
}

func renderShare(share Share) string {
	readOnly := "no"
	if share.ReadOnly {
		readOnly = "yes"
	}
	browseable := "yes"
	if !share.Browseable {
		browseable = "no"
	}
	section := fmt.Sprintf("[%s]\n", share.Name)
	if share.Comment != "" {
		section += fmt.Sprintf("    comment = %s\n", sanitise(share.Comment))
	}
	section += fmt.Sprintf("    path = %s\n", share.Path)
	section += fmt.Sprintf("    read only = %s\n", readOnly)
	section += fmt.Sprintf("    browseable = %s\n", browseable)
	// The POSIX access list is the access control; Samba must honour it rather
	// than impose a mask of its own on top.
	section += "    vfs objects = acl_xattr\n"
	section += "    map acl inherit = yes\n"
	section += "    store dos attributes = yes\n"
	section += "    inherit acls = yes\n"
	section += "    create mask = 0660\n"
	section += "    directory mask = 2770\n"
	return section
}

func parseSections(body string) map[string]string {
	sections := map[string]string{}
	name := ""
	current := strings.Builder{}
	flush := func() {
		if name != "" {
			sections[name] = current.String()
		}
		current.Reset()
	}
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			flush()
			name = strings.TrimSuffix(strings.TrimPrefix(trimmed, "["), "]")
			current.WriteString(trimmed + "\n")
			continue
		}
		if name == "" || trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		current.WriteString(line + "\n")
	}
	flush()
	return sections
}

func includeShares(env apply.Env) error {
	path := env.Path("/etc/samba/smb.conf")
	raw, err := os.ReadFile(path)
	if err != nil {
		// No smb.conf means the file-server role is not installed here, which
		// the caller will see as the share never becoming active.
		return fmt.Errorf("no %s on this machine; is the file-server role installed?", path)
	}
	if strings.Contains(string(raw), "include = "+SharesConf) {
		return nil
	}
	body := string(raw) + "\n# Managed by Open Directory Manager\ninclude = " + SharesConf + "\n"
	return env.WriteFile("/etc/samba/smb.conf", body, 0o644, "root", "root")
}

// Directories that are never a share, checked here as well as in the control
// plane. This process is root on the machine: it does not get to assume the
// thing telling it what to do has already thought about that.
var systemPaths = []string{
	"/", "/bin", "/boot", "/dev", "/etc", "/lib", "/proc", "/root",
	"/run", "/sbin", "/sys", "/usr", "/var/lib/samba",
}

func refuseSystemPath(path string) error {
	clean := strings.TrimRight(path, "/")
	if clean == "" {
		clean = "/"
	}
	for _, forbidden := range systemPaths {
		if clean == forbidden || (forbidden != "/" && strings.HasPrefix(clean, forbidden+"/")) {
			return fmt.Errorf("%s is not a directory ODM will share", path)
		}
	}
	return nil
}

// ---------------------------------------------------------------- helpers --

func str(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func boolean(value any, fallback bool) bool {
	if flag, ok := value.(bool); ok {
		return flag
	}
	return fallback
}

func stringList(value any, allowed *regexp.Regexp) ([]string, error) {
	raw, ok := value.([]any)
	if !ok {
		return nil, nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		text := str(item)
		if !allowed.MatchString(text) {
			return nil, fmt.Errorf("refusing %q", text)
		}
		out = append(out, text)
	}
	return out, nil
}

func sanitise(value string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '[' || r == ']' {
			return -1
		}
		return r
	}, value)
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return "this server"
	}
	return name
}
