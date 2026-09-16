package tasks

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"odm.example.org/agent/internal/apply"
)

// Watching somebody's screen, with their consent.
//
// The console is the viewer. The VNC server started here listens on this
// machine's loopback and nothing else, and the agent carries its bytes to
// the console over an outbound connection of its own (internal/relay), so
// an administrator clicks once and nothing on the machine is opened to the
// network. Two servers, because a desktop is one of two things: an X
// session, including every xrdp session, is attached to with x11vnc; a GNOME
// session on Wayland has no X server and shares through gnome-remote-desktop,
// whose VNC side is used where it exists (Debian 12) and whose RDP side is
// the fallback where it does not — reached directly then, with an address
// and a one-time password, the old way.
//
// Either way the person is asked first, the credential is one-time, and the
// sharing turns itself off again.

const assistMinutes = 30

// The port the VNC server takes on the loopback. The relay connects here.
const vncPort = 5900

type assistSession struct {
	user    string
	uid     int
	kind    string // "wayland" or "x11"
	display string // ":10" for an X session
	// The desktop's own environment, read from a process in the session:
	// where its display and its bus actually are. logind's idea of the
	// display is empty for a GDM session on either server, so asking logind
	// alone started every dialog with nowhere to draw.
	environment map[string]string
}

// The variables a program needs to reach a person's desktop.
var desktopVariables = []string{
	"DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "DBUS_SESSION_BUS_ADDRESS",
}

// desktopEnvironment finds a process of the session's owner that is part of
// the desktop and reads the display variables from it. The shell of the
// desktop first, since that is the process that certainly has them.
func desktopEnvironment(env apply.Env, uid int) map[string]string {
	entries, err := os.ReadDir(env.Path("/proc"))
	if err != nil {
		return nil
	}
	preferred := map[string]bool{
		"gnome-shell": true, "gnome-session-binary": true, "plasmashell": true,
		"xfce4-session": true, "mate-session": true, "cinnamon-session": true,
	}
	var fallback map[string]string
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		status, err := os.ReadFile(env.Path(fmt.Sprintf("/proc/%d/status", pid)))
		if err != nil || !ownedBy(string(status), uid) {
			continue
		}
		raw, err := os.ReadFile(env.Path(fmt.Sprintf("/proc/%d/environ", pid)))
		if err != nil {
			continue
		}
		found := map[string]string{}
		for _, pair := range strings.Split(string(raw), "\x00") {
			key, value, ok := strings.Cut(pair, "=")
			if !ok {
				continue
			}
			for _, wanted := range desktopVariables {
				if key == wanted && value != "" {
					found[key] = value
				}
			}
		}
		if found["DISPLAY"] == "" && found["WAYLAND_DISPLAY"] == "" {
			continue
		}
		comm, _ := os.ReadFile(env.Path(fmt.Sprintf("/proc/%d/comm", pid)))
		if preferred[strings.TrimSpace(string(comm))] {
			return found
		}
		if fallback == nil {
			fallback = found
		}
	}
	return fallback
}

// ownedBy reads the real uid out of /proc/<pid>/status.
func ownedBy(status string, uid int) bool {
	for _, line := range strings.Split(status, "\n") {
		if strings.HasPrefix(line, "Uid:") {
			fields := strings.Fields(line)
			return len(fields) > 1 && fields[1] == strconv.Itoa(uid)
		}
	}
	return false
}

// runRemoteAssist offers one person's session to whoever asked, for a while.
func runRemoteAssist(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	user, _ := payload["username"].(string)
	if !safeName.MatchString(user) {
		return "", fmt.Errorf("invalid user %q", user)
	}
	asked, _ := payload["requested_by"].(string)
	minutes := intOf(payload["minutes"], assistMinutes)
	if minutes < 1 || minutes > 240 {
		minutes = assistMinutes
	}

	session, err := findSession(ctx, env, user)
	if err != nil {
		return "", err
	}
	if !consented(ctx, env, session, asked) {
		return "", fmt.Errorf("%s did not accept", user)
	}
	password, err := oneTimePassword()
	if err != nil {
		return "", err
	}

	if session.kind == "wayland" {
		if err := shareWaylandVNC(ctx, env, session, password, minutes); err == nil {
			return fmt.Sprintf("vnc %d - %s %d", vncPort, password, minutes), nil
		}
		if err := shareWayland(ctx, env, session, password, minutes); err != nil {
			return "", err
		}
		return fmt.Sprintf("rdp 3389 odm-assist %s %d", password, minutes), nil
	}
	if err := shareX11(ctx, env, session, password, minutes); err != nil {
		return "", err
	}
	return fmt.Sprintf("vnc %d - %s %d", vncPort, password, minutes), nil
}

// AssistRelay says, from a remote-assist task's payload and answer, whether
// the agent should carry the screen to the console, and until when. The
// loop in main starts the relay beside the queue when it does.
func AssistRelay(payload map[string]any, answer string) (session string, address string, until time.Time, ok bool) {
	session, _ = payload["session"].(string)
	fields := strings.Fields(answer)
	if session == "" || len(fields) < 5 || fields[0] != "vnc" {
		return "", "", time.Time{}, false
	}
	minutes, _ := strconv.Atoi(fields[4])
	if minutes < 1 {
		minutes = assistMinutes
	}
	return session, "127.0.0.1:" + fields[1], time.Now().Add(time.Duration(minutes) * time.Minute), true
}

// findSession is the graphical session this person is actually sitting in.
func findSession(ctx context.Context, env apply.Env, user string) (assistSession, error) {
	out, err := env.Run.Run(ctx, "loginctl", "list-sessions", "--no-legend")
	if err != nil {
		return assistSession{}, fmt.Errorf("asking which sessions are open: %w", err)
	}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || !strings.EqualFold(fields[2], user) {
			continue
		}
		detail, err := env.Run.Run(ctx, "loginctl", "show-session", fields[0],
			"-p", "Type", "-p", "Display")
		if err != nil {
			continue
		}
		values := map[string]string{}
		for _, entry := range strings.Split(detail, "\n") {
			if key, value, ok := strings.Cut(strings.TrimSpace(entry), "="); ok {
				values[key] = value
			}
		}
		uid, _ := strconv.Atoi(fields[1])
		if values["Type"] != "wayland" && values["Type"] != "x11" {
			continue
		}
		session := assistSession{user: user, uid: uid, kind: values["Type"], display: values["Display"]}
		session.environment = desktopEnvironment(env, uid)
		// The desktop's own word beats logind's: it is the one that is
		// actually drawing on the display.
		if display := session.environment["DISPLAY"]; display != "" {
			session.display = display
		}
		if session.environment["XDG_SESSION_TYPE"] == "x11" && session.environment["WAYLAND_DISPLAY"] == "" {
			session.kind = "x11"
		}
		return session, nil
	}
	return assistSession{}, fmt.Errorf("%s has no graphical session on this machine", user)
}

// consented asks the person, in their own session, and takes silence for no.
func consented(ctx context.Context, env apply.Env, session assistSession, asked string) bool {
	if asked == "" {
		asked = "An administrator"
	}
	_, err := runAs(ctx, env, session, "zenity", "--question", "--no-wrap",
		"--timeout=60", "--title=Remote assistance",
		"--text="+asked+" would like to watch your screen to help you.\n\nAllow?")
	return err == nil
}

// shareWaylandVNC turns on the VNC side of GNOME's own remote desktop, where
// it has one (gnome-remote-desktop 43, Debian 12; later releases dropped
// it). It fails where there is none, and the caller falls back to RDP.
func shareWaylandVNC(
	ctx context.Context, env apply.Env, session assistSession, password string, minutes int,
) error {
	steps := [][]string{
		{"grdctl", "vnc", "set-auth-method", "password"},
		{"grdctl", "vnc", "set-password", password},
		{"grdctl", "vnc", "disable-view-only"},
		{"grdctl", "vnc", "enable"},
	}
	for _, step := range steps {
		if _, err := runAs(ctx, env, session, step[0], step[1:]...); err != nil {
			return fmt.Errorf("offering the screen over VNC: %w", err)
		}
	}
	_, _ = env.Run.Run(ctx, "systemd-run", "--quiet",
		fmt.Sprintf("--on-active=%dmin", minutes),
		fmt.Sprintf("--unit=odm-assist-off-%d", session.uid),
		"--uid", strconv.Itoa(session.uid),
		"--setenv=XDG_RUNTIME_DIR=/run/user/"+strconv.Itoa(session.uid),
		"--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"+
			strconv.Itoa(session.uid)+"/bus",
		"grdctl", "vnc", "disable")
	return nil
}

// shareWayland turns on GNOME's own remote desktop for this session.
func shareWayland(
	ctx context.Context, env apply.Env, session assistSession, password string, minutes int,
) error {
	steps := [][]string{
		{"grdctl", "rdp", "set-credentials", "odm-assist", password},
		{"grdctl", "rdp", "disable-view-only"},
		{"grdctl", "rdp", "enable"},
	}
	for _, step := range steps {
		if _, err := runAs(ctx, env, session, step[0], step[1:]...); err != nil {
			return fmt.Errorf("offering the screen: %w", err)
		}
	}
	// And off again, whatever happens next.
	_, _ = env.Run.Run(ctx, "systemd-run", "--quiet",
		fmt.Sprintf("--on-active=%dmin", minutes),
		fmt.Sprintf("--unit=odm-assist-off-%d", session.uid),
		"--uid", strconv.Itoa(session.uid),
		"--setenv=XDG_RUNTIME_DIR=/run/user/"+strconv.Itoa(session.uid),
		"--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"+
			strconv.Itoa(session.uid)+"/bus",
		"grdctl", "rdp", "disable")
	return nil
}

// shareX11 attaches to an X session, which is every xrdp session.
func shareX11(
	ctx context.Context, env apply.Env, session assistSession, password string, minutes int,
) error {
	if _, err := exec.LookPath("x11vnc"); err != nil {
		// Fetched the first time it is needed rather than shipped to every
		// machine: most are never watched, and the person has just said
		// yes, so the moment is right.
		if out, err := apply.Unsandboxed(ctx, env, "apt-get", "install", "-y", "--no-install-recommends", "x11vnc"); err != nil {
			return fmt.Errorf("x11vnc is not installed and could not be installed: %w: %s", err, strings.TrimSpace(out))
		}
	}
	display := session.display
	if display == "" {
		display = ":0"
	}
	xauthority := session.environment["XAUTHORITY"]
	if xauthority == "" {
		xauthority = "/run/user/" + strconv.Itoa(session.uid) + "/gdm/Xauthority"
	}
	// An offer that is still running from last time would keep the unit
	// name and the port; it is over now, whatever it was.
	unit := fmt.Sprintf("odm-assist-%d", session.uid)
	_, _ = env.Run.Run(ctx, "systemctl", "stop", unit+".service")
	// Loopback only: the relay is the one client that reaches it. It stays
	// up for the whole offer (-forever) so a viewer can close its tab and
	// open another, and the unit's own time limit turns it off.
	_, err := env.Run.Run(ctx, "systemd-run", "--quiet",
		"--unit="+unit,
		"--uid", strconv.Itoa(session.uid),
		fmt.Sprintf("--property=RuntimeMaxSec=%d", minutes*60),
		"--setenv=XAUTHORITY="+xauthority,
		"x11vnc", "-display", display, "-forever", "-shared", "-localhost",
		"-rfbport", strconv.Itoa(vncPort),
		"-passwd", password, "-noxdamage", "-repeat")
	return err
}

// runAs runs one command inside somebody's own session, which is where their
// desktop, its bus and its screen are.
func runAs(
	ctx context.Context, env apply.Env, session assistSession, name string, args ...string,
) (string, error) {
	runtime := "/run/user/" + strconv.Itoa(session.uid)
	full := []string{
		"--quiet", "--pipe", "--wait", "--collect",
		"--uid", strconv.Itoa(session.uid),
		"--setenv=XDG_RUNTIME_DIR=" + runtime,
		"--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=" + runtime + "/bus",
	}
	// The desktop's own display variables, as its shell has them. logind
	// does not know a GDM session's display on either server, and a GTK
	// program handed an empty DISPLAY cannot open anything and exits at
	// once — which read as the person refusing before they had been asked.
	given := map[string]bool{}
	for _, key := range desktopVariables {
		if value := session.environment[key]; value != "" && key != "DBUS_SESSION_BUS_ADDRESS" {
			full = append(full, "--setenv="+key+"="+value)
			given[key] = true
		}
	}
	if !given["DISPLAY"] && session.display != "" {
		full = append(full, "--setenv=DISPLAY="+session.display)
	}
	if session.kind == "wayland" && !given["WAYLAND_DISPLAY"] {
		if socket := waylandSocket(env, runtime); socket != "" {
			full = append(full, "--setenv=WAYLAND_DISPLAY="+socket)
		}
	}
	if !given["XAUTHORITY"] && session.kind == "x11" {
		full = append(full, "--setenv=XAUTHORITY="+runtime+"/gdm/Xauthority")
	}
	full = append(append(full, "--", name), args...)
	return env.Run.Run(ctx, "systemd-run", full...)
}

// waylandSocket is the compositor's socket in a session's runtime
// directory — wayland-0 almost always, but read rather than assumed.
func waylandSocket(env apply.Env, runtime string) string {
	entries, err := os.ReadDir(env.Path(runtime))
	if err != nil {
		return "wayland-0"
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, "wayland-") && !strings.HasSuffix(name, ".lock") {
			return name
		}
	}
	return "wayland-0"
}

// oneTimePassword is what the viewer is given, and it is given once.
func oneTimePassword() (string, error) {
	raw := make([]byte, 9)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
