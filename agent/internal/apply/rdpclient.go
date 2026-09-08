package apply

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// What opens a connection file once it is on somebody's desktop.
//
// Writing the file was only half of it. Debian's Remmina does not claim
// Microsoft's .rdp format at all — its desktop entry lists
// application/x-remmina and the rdp:// scheme, not application/x-rdp — and
// without its RDP plugin it cannot even read one: opening the file answered
//
//	The file '…/mitarbeitende.rdp' is corrupted, unreadable, or could not
//	be found.
//
// over a perfectly good connection file. So the machine gets something that
// claims the type and knows what to do with it, and the client it needs.

const (
	rdpOpener      = "/usr/lib/odm/open-remote-desktop"
	rdpDesktopFile = "/usr/share/applications/odm-remote-desktop.desktop"
	xsessionsDir   = "/usr/share/xsessions"
)

// rdpClients are the ways this machine might already be able to open one.
var rdpClients = []string{"xfreerdp3", "xfreerdp", "wlfreerdp"}

// applyRemoteDesktopClient makes .rdp files openable on a machine whose policy
// hands them out. A machine that gets none is left alone: this is the cost of
// the feature, not a package every desktop in the domain should carry.
func applyRemoteDesktopClient(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.RemoteDesktopFiles) == 0 {
		return nil
	}
	if !hasDesktop(env) {
		// Nobody double-clicks anything here.
		return []policy.Result{policy.Skip("remote_desktop_client", "no graphical session on this machine")}
	}
	if err := writeRdpOpener(env); err != nil {
		return []policy.Result{policy.Fail("remote_desktop_client", err)}
	}
	if rdpClientPresent(env) {
		return []policy.Result{policy.Ok("remote_desktop_client")}
	}
	if env.Run == nil {
		return []policy.Result{policy.Skip("remote_desktop_client", "no command runner")}
	}
	// Remmina without its RDP plugin is the state Debian's desktop task
	// leaves: the application is there and the one protocol wanted here is
	// not.
	// The allowlist is for what people install, not for what the policy that
	// hands out connection files needs to open one.
	defer SuspendSoftwareControl(env)()
	if _, err := Unsandboxed(ctx, env, "apt-get", "install", "-y", "--no-install-recommends",
		"remmina", "remmina-plugin-rdp"); err != nil {
		return []policy.Result{policy.Fail("remote_desktop_client", err)}
	}
	if !rdpClientPresent(env) {
		return []policy.Result{policy.Fail("remote_desktop_client",
			errors.New("no remote desktop client after installing remmina-plugin-rdp"))}
	}
	return []policy.Result{policy.Ok("remote_desktop_client")}
}

// hasDesktop is whether anybody can sign in graphically here.
func hasDesktop(env Env) bool {
	entries, err := os.ReadDir(env.Path(xsessionsDir))
	return err == nil && len(entries) > 0
}

// rdpClientPresent is whether the opener would find something to run.
func rdpClientPresent(env Env) bool {
	plugins, _ := filepath.Glob(env.Path("/usr/lib/*/remmina/plugins/remmina-plugin-rdp.so"))
	if len(plugins) > 0 {
		return true
	}
	for _, client := range rdpClients {
		for _, dir := range []string{"/usr/bin", "/usr/local/bin", "/bin"} {
			if _, err := os.Stat(env.Path(filepath.Join(dir, client))); err == nil {
				return true
			}
		}
	}
	return false
}

// writeRdpOpener puts an application behind the type. Exactly one desktop
// entry claiming application/x-rdp is enough for a file manager to open it
// without anybody having to choose a default first.
func writeRdpOpener(env Env) error {
	script := "#!/bin/sh\n" + Header + `
# Open a remote desktop connection file with whatever client is installed.
[ -n "${1:-}" ] || exit 2

# Remmina reads a .rdp through its RDP plugin's importer. Without the plugin
# it reads nothing, which is why the plugin is what is checked for rather
# than the application.
for plugin in /usr/lib/*/remmina/plugins/remmina-plugin-rdp.so; do
    if [ -e "$plugin" ] && command -v remmina >/dev/null 2>&1; then
        exec remmina -c "$1"
    fi
done

for client in xfreerdp3 xfreerdp wlfreerdp; do
    if command -v "$client" >/dev/null 2>&1; then
        exec "$client" "$1"
    fi
done

message="No remote desktop client is installed on this machine."
if command -v zenity >/dev/null 2>&1; then
    zenity --error --no-wrap --text="$message"
elif command -v notify-send >/dev/null 2>&1; then
    notify-send "Remote desktop" "$message"
fi
exit 1
`
	if err := env.WriteFile(rdpOpener, script, 0o755, "root", "root"); err != nil {
		return err
	}
	entry := "[Desktop Entry]\n" +
		"Type=Application\n" +
		"Name=Remote desktop connection\n" +
		"Comment=Open a remote desktop connection file\n" +
		"Exec=" + rdpOpener + " %f\n" +
		"Icon=org.remmina.Remmina\n" +
		"Terminal=false\n" +
		"NoDisplay=true\n" +
		"MimeType=application/x-rdp;\n" +
		"# " + strings.TrimSuffix(strings.TrimPrefix(Header, "# "), "\n") + "\n"
	if err := env.WriteFile(rdpDesktopFile, entry, 0o644, "root", "root"); err != nil {
		return err
	}
	return refreshDesktopDatabase(env)
}

func refreshDesktopDatabase(env Env) error {
	if env.Run == nil {
		return nil
	}
	// Not fatal: the entry is on disk either way and the database is rebuilt
	// by the next package that installs a desktop file.
	_, _ = env.Run.Run(context.Background(), "update-desktop-database",
		env.Path("/usr/share/applications"))
	return nil
}
