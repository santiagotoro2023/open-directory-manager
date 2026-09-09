package tasks

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os/exec"
	"strconv"
	"strings"

	"odm.example.org/agent/internal/apply"
)

// Watching somebody's screen, with their consent.
//
// Two ways in, because a desktop is one of two things. A GNOME session on
// Wayland has no X server to attach to and shares through
// gnome-remote-desktop, which speaks RDP — the protocol the rest of this
// console already deals in. An X session, including every xrdp session, is
// attached to with x11vnc.
//
// Either way the person is asked first, the credential is one-time, and the
// sharing turns itself off again.

const assistMinutes = 30

type assistSession struct {
	user    string
	uid     int
	kind    string // "wayland" or "x11"
	display string // ":10" for an X session
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
		if err := shareWayland(ctx, env, session, password, minutes); err != nil {
			return "", err
		}
		return fmt.Sprintf("rdp 3389 odm-assist %s %d", password, minutes), nil
	}
	if err := shareX11(ctx, env, session, password, minutes); err != nil {
		return "", err
	}
	return fmt.Sprintf("vnc 5900 - %s %d", password, minutes), nil
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
		switch values["Type"] {
		case "wayland":
			return assistSession{user: user, uid: uid, kind: "wayland"}, nil
		case "x11":
			return assistSession{user: user, uid: uid, kind: "x11", display: values["Display"]}, nil
		}
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
		return fmt.Errorf("x11vnc is not installed, so an X session cannot be offered")
	}
	display := session.display
	if display == "" {
		display = ":0"
	}
	_, err := env.Run.Run(ctx, "systemd-run", "--quiet",
		fmt.Sprintf("--unit=odm-assist-%d", session.uid),
		"--uid", strconv.Itoa(session.uid),
		"--setenv=XAUTHORITY=/run/user/"+strconv.Itoa(session.uid)+"/gdm/Xauthority",
		"x11vnc", "-display", display, "-once", "-shared",
		"-timeout", strconv.Itoa(minutes*60),
		"-passwd", password, "-noxdamage", "-repeat")
	return err
}

// runAs runs one command inside somebody's own session, which is where their
// desktop, its bus and its screen are.
func runAs(
	ctx context.Context, env apply.Env, session assistSession, name string, args ...string,
) (string, error) {
	full := append([]string{
		"--quiet", "--pipe", "--wait", "--collect",
		"--uid", strconv.Itoa(session.uid),
		"--setenv=XDG_RUNTIME_DIR=/run/user/" + strconv.Itoa(session.uid),
		"--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" +
			strconv.Itoa(session.uid) + "/bus",
		"--setenv=DISPLAY=" + session.display,
		"--", name,
	}, args...)
	return env.Run.Run(ctx, "systemd-run", full...)
}

// oneTimePassword is what the viewer is given, and it is given once.
func oneTimePassword() (string, error) {
	raw := make([]byte, 9)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
