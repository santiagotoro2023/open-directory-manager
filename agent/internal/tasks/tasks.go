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
	"time"

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
	return RunWithProgress(ctx, task, env, nil)
}

// RunWithProgress is Run, reporting a long task's output while it is still
// running. progress may be nil.
func RunWithProgress(
	ctx context.Context, task Task, env apply.Env, progress Progress,
) Result {
	var output string
	var err error

	// A task that never returns is worse than one that fails: the agent is
	// single-threaded, so it stops collecting work entirely and the console
	// shows "installing" forever with nothing to say why. An installer that
	// is still going after this has hit a prompt nothing will ever answer.
	ctx, cancel := context.WithTimeout(ctx, timeoutFor(task.Kind))
	defer cancel()

	switch task.Kind {
	case "role-install":
		output, err = installRole(ctx, task.Payload, env, progress)
	case "console-certificate":
		output, err = applyConsoleCertificate(ctx, env)
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
		// The agent ends its wait when it sees this and applies again with
		// force, so there is nothing for the task itself to do. It used to say
		// the same and there was no such run: tasks are collected between
		// applies as well as during one, so Refresh in the console did nothing
		// at all until the next quarter-hour tick.
		output = "applying the policy again now"
	case "restart":
		output, err = power(ctx, env, "reboot")
	case "shutdown":
		output, err = power(ctx, env, "poweroff")
	case "domain-backup":
		output, err = takeDomainBackup(ctx, task.Payload, env)
	case "printer-discover":
		output, err = discoverPrinters(ctx, env)
	case "browse":
		output, err = browse(ctx, task.Payload, env)
	case "make-directory":
		output, err = makeDirectory(ctx, task.Payload, env)
	case "local-user-add":
		output, err = addLocalUser(ctx, task.Payload, env)
	case "local-user-remove":
		output, err = removeLocalUser(ctx, task.Payload, env)
	case "printer-apply":
		output, err = applyPrinter(ctx, task.Payload, env)
	case "printer-remove":
		output, err = removePrinter(ctx, task.Payload, env)
	case "vpn-apply":
		output, err = applyTunnel(ctx, task.Payload, env)
	case "radius-apply":
		output, err = applyRadius(ctx, task.Payload, env)
	case "rd-host-apply":
		output, err = applyRemoteDesktopHost(ctx, task.Payload, env)
	case "rd-broker-apply":
		output, err = applyRemoteDesktopBroker(ctx, task.Payload, env)
	default:
		err = fmt.Errorf("unknown task kind %q", task.Kind)
	}

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			err = fmt.Errorf(
				"gave up after %s: %w (an installer waiting on a prompt looks like this)",
				timeoutFor(task.Kind), err,
			)
		}
		return Result{ID: task.ID, OK: false, Output: strings.TrimSpace(output + "\n" + err.Error())}
	}
	return Result{ID: task.ID, OK: true, Output: strings.TrimSpace(output)}
}

// timeoutFor bounds one task. Installing a role is apt over a network and can
// legitimately take a while; everything else is local and quick.
func timeoutFor(kind string) time.Duration {
	switch kind {
	case "role-install", "update-install", "domain-backup":
		return 30 * time.Minute
	case "update-check", "package-install", "package-remove":
		return 10 * time.Minute
	case "browse", "make-directory":
		// A click in a dialog. Nobody waits five minutes for one.
		return 30 * time.Second
	case "printer-discover":
		// A network sweep, which the agent bounds at twenty seconds.
		return 60 * time.Second
	default:
		return 5 * time.Minute
	}
}

func installRole(
	ctx context.Context, payload map[string]any, env apply.Env, progress Progress,
) (string, error) {
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
	return unsandboxed(ctx, env, progress, installer, arguments...)
}

// unsandboxed runs a command as a transient systemd unit instead of as a
// child of the agent.
//
// A service's sandbox is inherited by everything it spawns, and the agent's
// unit is hardened because applying policy should be. A package's postinst is
// not policy: it is arbitrary root code written against an ordinary machine,
// and under our restrictions it fails in ways that read as a broken package.
// freeradius' postinst chmods /etc/freeradius and gets EPERM from
// RestrictSUIDSGID; dpkg is then left half-configured, and from that point
// every later install fails with unmet dependencies that are in fact
// perfectly installable — which is what "no role could be installed" was.
//
// systemd-run asks PID 1 to start the command, so it runs with the system's
// own defaults rather than ours. Where there is no systemd — a container, a
// test — run it directly.
func unsandboxed(
	ctx context.Context, env apply.Env, progress Progress, name string, args ...string,
) (string, error) {
	if env.Root != "" {
		return env.Run.Run(ctx, name, args...)
	}
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return env.Run.Run(ctx, name, args...)
	}
	run := append([]string{"--pipe", "--wait", "--collect", "--quiet", "--", name}, args...)
	if progress == nil {
		return env.Run.Run(ctx, "systemd-run", run...)
	}
	return stream(ctx, progress, "systemd-run", run...)
}

// applyConsoleCertificate installs a certificate the control plane has already
// staged on this machine and restarts it.
//
// The control plane runs sandboxed and unprivileged, so it cannot write /etc
// or restart a service even on its own host. It writes the pair where it may
// and asks the agent — which is root here — to put it where the service reads
// it. Nothing private travels through the task queue: the payload is empty and
// the helper takes no arguments.
func applyConsoleCertificate(ctx context.Context, env apply.Env) (string, error) {
	helper := env.Path(filepath.Join(RoleDir, "odm-apply-console-certificate"))
	if _, err := os.Stat(helper); err != nil {
		return "", fmt.Errorf(
			"%s is not installed on this machine; reinstall the agent package", helper,
		)
	}
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	return env.Run.Run(ctx, helper)
}

// checkUpdates refreshes the package index and reports what an upgrade would
// do. It changes nothing: the count it produces is what the console shows
// before an operator decides.
func checkUpdates(ctx context.Context, env apply.Env) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	if out, err := env.Run.Run(ctx, "apt-get", "-o", "DPkg::Lock::Timeout=600", "update", "-qq"); err != nil {
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
	if out, err := env.Run.Run(ctx, "apt-get", "-o", "DPkg::Lock::Timeout=600", "update", "-qq"); err != nil {
		return out, fmt.Errorf("refreshing the package index: %w", err)
	}
	out, err := unsandboxed(ctx, env, nil,
		"apt-get", "upgrade", "-y",
		"-o", "Dpkg::Options::=--force-confold",
		"-o", "Dpkg::Options::=--force-confdef",
		// Without this apt waits for the dpkg lock for ever, which on a
		// machine that has just booted means until unattended-upgrades
		// finishes — and the console shows nothing but "installing".
		"-o", "DPkg::Lock::Timeout=600",
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
		if out, err := env.Run.Run(ctx, "apt-get", "-o", "DPkg::Lock::Timeout=600", "update", "-qq"); err != nil {
			return out, fmt.Errorf("refreshing the package index: %w", err)
		}
	}
	action := "install"
	if !install {
		// purge would take the configuration with it, which is not what
		// "uninstall" means to someone reading a button.
		action = "remove"
	}
	out, err := unsandboxed(ctx, env, nil,
		"apt-get", action, "-y",
		"-o", "Dpkg::Options::=--force-confold",
		"-o", "Dpkg::Options::=--force-confdef",
		"-o", "DPkg::Lock::Timeout=600",
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

// ---------------------------------------------------------------- printers --

const ppdDir = "/etc/cups/odm-ppd"

var safeURI = regexp.MustCompile(`^(ipp|ipps|socket|lpd|usb|smb|dnssd)://[A-Za-z0-9._~:/?#%@!$&'()*+,;=-]{1,240}$`)

func applyPrinter(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	name := str(payload["name"])
	uri := str(payload["device_uri"])
	if !safeName.MatchString(name) {
		return "", fmt.Errorf("invalid printer name %q", name)
	}
	if !safeURI.MatchString(uri) {
		return "", fmt.Errorf("invalid device address %q", uri)
	}
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}

	// A PPD is optional. Where one was uploaded it is written out and named;
	// otherwise CUPS is told to work the printer out for itself, which is what
	// IPP Everywhere is for.
	args := []string{"-p", name, "-E", "-v", uri}
	if ppd := str(payload["ppd"]); ppd != "" {
		if err := os.MkdirAll(env.Path(ppdDir), 0o755); err != nil {
			return "", fmt.Errorf("creating %s: %w", ppdDir, err)
		}
		path := ppdDir + "/" + name + ".ppd"
		if err := env.WriteFile(path, ppd, 0o644, "root", "root"); err != nil {
			return "", fmt.Errorf("writing the PPD: %w", err)
		}
		args = append(args, "-P", env.Path(path))
	} else {
		args = append(args, "-m", "everywhere")
	}
	if description := str(payload["description"]); description != "" {
		args = append(args, "-D", sanitise(description))
	}
	if location := str(payload["location"]); location != "" {
		args = append(args, "-L", sanitise(location))
	}
	if boolean(payload["shared"], true) {
		args = append(args, "-o", "printer-is-shared=true")
	} else {
		args = append(args, "-o", "printer-is-shared=false")
	}
	if boolean(payload["duplex"], false) {
		args = append(args, "-o", "sides-default=two-sided-long-edge")
	}
	if !boolean(payload["colour"], true) {
		args = append(args, "-o", "print-color-mode-default=monochrome")
	}

	if out, err := env.Run.Run(ctx, "lpadmin", args...); err != nil {
		return out, fmt.Errorf("lpadmin: %w", err)
	}
	// A queue that exists but is not accepting jobs looks broken to a client.
	_, _ = env.Run.Run(ctx, "cupsenable", name)
	_, _ = env.Run.Run(ctx, "cupsaccept", name)
	return fmt.Sprintf("%s is published at ipp://%s/printers/%s", name, hostname(), name), nil
}

func removePrinter(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	name := str(payload["name"])
	if !safeName.MatchString(name) {
		return "", fmt.Errorf("invalid printer name %q", name)
	}
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	if out, err := env.Run.Run(ctx, "lpadmin", "-x", name); err != nil {
		return out, fmt.Errorf("lpadmin -x %s: %w", name, err)
	}
	_ = os.Remove(env.Path(ppdDir + "/" + name + ".ppd"))
	return name + " removed", nil
}

// --------------------------------------------------------------------- vpn --

const wireguardDir = "/etc/wireguard"

func applyTunnel(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	name := str(payload["name"])
	if !safeName.MatchString(name) {
		return "", fmt.Errorf("invalid tunnel name %q", name)
	}
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	unit := "wg-quick@" + name
	path := fmt.Sprintf("%s/%s.conf", wireguardDir, name)

	if boolean(payload["remove"], false) {
		_, _ = env.Run.Run(ctx, "systemctl", "disable", "--now", unit)
		_ = os.Remove(env.Path(path))
		return name + " taken down", nil
	}

	body, err := RenderServer(payload, externalInterface(env))
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(env.Path(wireguardDir), 0o700); err != nil {
		return "", fmt.Errorf("creating %s: %w", wireguardDir, err)
	}
	// 0600: the file is the tunnel's identity.
	if err := env.WriteFile(path, body, 0o600, "root", "root"); err != nil {
		return "", fmt.Errorf("writing %s: %w", path, err)
	}

	if out, err := env.Run.Run(ctx, "systemctl", "enable", unit); err != nil {
		return out, fmt.Errorf("enabling %s: %w", unit, err)
	}
	if out, err := env.Run.Run(ctx, "systemctl", "restart", unit); err != nil {
		return out, fmt.Errorf("starting %s: %w", unit, err)
	}
	peers, _ := payload["peers"].([]any)
	return fmt.Sprintf("%s is up with %d peers", name, len(peers)), nil
}

// RenderServer writes the server side of a tunnel. Exported so what lands in
// /etc/wireguard can be asserted without a network interface.
func RenderServer(payload map[string]any, external string) (string, error) {
	address := str(payload["address"])
	private := str(payload["private_key"])
	if address == "" || private == "" {
		return "", fmt.Errorf("the tunnel has no address or key")
	}
	port := 51820
	if raw, ok := payload["listen_port"].(float64); ok && raw > 0 {
		port = int(raw)
	}

	var out strings.Builder
	out.WriteString("# Managed by Open Directory Manager. Edits here are overwritten.\n")
	out.WriteString("[Interface]\n")
	fmt.Fprintf(&out, "Address = %s\n", address)
	fmt.Fprintf(&out, "ListenPort = %d\n", port)
	fmt.Fprintf(&out, "PrivateKey = %s\n", private)
	// Without these a peer connects and reaches the server but nothing behind
	// it, which looks like a broken tunnel rather than a missing route.
	fmt.Fprintf(&out,
		"PostUp = iptables -t nat -A POSTROUTING -o %s -j MASQUERADE; "+
			"iptables -A FORWARD -i %%i -j ACCEPT\n", external)
	fmt.Fprintf(&out,
		"PostDown = iptables -t nat -D POSTROUTING -o %s -j MASQUERADE; "+
			"iptables -D FORWARD -i %%i -j ACCEPT\n", external)

	peers, _ := payload["peers"].([]any)
	for _, raw := range peers {
		peer, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		key := str(peer["public_key"])
		allowed, err := stringList(peer["allowed_ips"], safeCIDR)
		if err != nil || key == "" || len(allowed) == 0 {
			continue
		}
		out.WriteString("\n[Peer]\n")
		if name := str(peer["name"]); name != "" {
			fmt.Fprintf(&out, "# %s\n", sanitise(name))
		}
		fmt.Fprintf(&out, "PublicKey = %s\n", key)
		fmt.Fprintf(&out, "AllowedIPs = %s\n", strings.Join(allowed, ", "))
	}
	return out.String(), nil
}

var safeCIDR = regexp.MustCompile(`^[0-9a-fA-F.:]{2,45}(/[0-9]{1,3})?$`)

// externalInterface is recorded by the role installer, which knows which way
// out the machine routes.
func externalInterface(env apply.Env) string {
	raw, err := os.ReadFile(env.Path(wireguardDir + "/odm-external-interface"))
	name := strings.TrimSpace(string(raw))
	if err != nil || name == "" || !safeName.MatchString(name) {
		return "eth0"
	}
	return name
}

// ------------------------------------------------------------------ radius --

// Where the role installer told FreeRADIUS to look. Only these two files are
// written; the rest of the configuration is the distribution's.
const (
	radiusClientsPath  = "/etc/freeradius/3.0/odm/clients.conf"
	radiusPoliciesPath = "/etc/freeradius/3.0/odm/policy.conf"
)

func applyRadius(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	clients := str(payload["clients"])
	policies := str(payload["policies"])
	if clients == "" && policies == "" {
		return "", fmt.Errorf("nothing to write")
	}
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}

	// 0640 and owned by freerad: the shared secrets are in here.
	for _, file := range []struct{ path, body string }{
		{radiusClientsPath, clients},
		{radiusPoliciesPath, policies},
	} {
		if err := env.WriteFile(file.path, file.body, 0o640, "freerad", "freerad"); err != nil {
			return "", fmt.Errorf("writing %s: %w", file.path, err)
		}
	}

	// A configuration FreeRADIUS refuses would take the service down on
	// restart, so it is checked before anything is restarted.
	if out, err := env.Run.Run(ctx, "freeradius", "-CX"); err != nil {
		return out, fmt.Errorf("freeradius refused the configuration: %w", err)
	}
	if out, err := env.Run.Run(ctx, "systemctl", "reload-or-restart", "freeradius"); err != nil {
		return out, fmt.Errorf("reloading freeradius: %w", err)
	}
	return "network access rules applied", nil
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
	// Into [global], not onto the end of the file. Appended last it lands
	// inside whatever section happens to be there — [netlogon], on a domain
	// controller — where Samba reads it as that share's parameter rather than
	// the domain's, and testparm shows it in a place no operator put it.
	body := insertIntoGlobal(
		string(raw), "\n# Managed by Open Directory Manager\ninclude = "+SharesConf+"\n",
	)
	return env.WriteFile("/etc/samba/smb.conf", body, 0o644, "root", "root")
}

// insertIntoGlobal puts a line at the end of the [global] section, or at the
// end of the file when there is no other section to fall inside.
func insertIntoGlobal(body, line string) string {
	lines := strings.Split(body, "\n")
	inGlobal := false
	for index, text := range lines {
		trimmed := strings.TrimSpace(text)
		if !strings.HasPrefix(trimmed, "[") {
			continue
		}
		if strings.EqualFold(trimmed, "[global]") {
			inGlobal = true
			continue
		}
		if inGlobal {
			rest := strings.Join(lines[index:], "\n")
			return strings.Join(lines[:index], "\n") + line + "\n" + rest
		}
	}
	return body + line
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
