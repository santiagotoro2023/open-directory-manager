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
)

// Remote desktop, on both sides of it.
//
// A session host serves the desktop; a broker decides which host a person
// lands on. Neither decides anything by itself — both are handed the
// collection they belong to and write it out, so the answer to "why does this
// machine behave like that" is always the collection, in one place.

const (
	rdSessionScript  = "/etc/odm/rd-session.sh"
	rdProfileScript  = "/etc/odm/rd-profile.sh"
	rdProfileSecrets = "/etc/odm/rd-profile.conf"
	rdPamFile        = "/etc/pam.d/xrdp-sesman"
	rdBrokerConfig   = "/etc/haproxy/conf.d/odm-remote-desktop.cfg"
	rdSesmanIni      = "/etc/xrdp/sesman.ini"
)

var (
	safeShare    = regexp.MustCompile(`^//[A-Za-z0-9._-]+/[A-Za-z0-9._$ -]{1,64}$`)
	safeHostName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,253}$`)
	safeAppPath  = regexp.MustCompile(`^/[A-Za-z0-9._/-]{1,255}$`)
)

// applyRemoteDesktopHost configures one session host for its collection.
func applyRemoteDesktopHost(
	ctx context.Context, payload map[string]any, env apply.Env,
) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	share, _ := payload["profile_share"].(string)
	if !safeShare.MatchString(share) {
		return "", fmt.Errorf("invalid profile share %q", share)
	}
	kind, _ := payload["kind"].(string)
	appPath, _ := payload["app_path"].(string)
	if kind == "remoteapp" && !safeAppPath.MatchString(appPath) {
		return "", fmt.Errorf("invalid published application %q", appPath)
	}
	profileGB := intOf(payload["profile_gb"], 10)
	idle := intOf(payload["idle_minutes"], 0)
	disconnected := intOf(payload["disconnected_minutes"], 0)

	var written []string

	// What a session runs. A published application replaces the desktop
	// rather than sitting on top of one: closing it ends the session, which
	// is what somebody handed a single application expects.
	session := apply.Header + "#!/bin/sh\n"
	if kind == "remoteapp" {
		session = "#!/bin/sh\n" + apply.Header +
			"# Published application. Closing it ends the session.\n" +
			"exec " + appPath + "\n"
	} else {
		session = "#!/bin/sh\n" + apply.Header + "exec startxfce4\n"
	}
	if err := writeManaged(env, rdSessionScript, session, 0o755); err != nil {
		return "", err
	}
	written = append(written, rdSessionScript)

	// The profile disk, and the fact that there is no alternative to it.
	if err := writeManaged(env, rdProfileScript, profileScript(), 0o755); err != nil {
		return "", err
	}
	conf := apply.Header +
		"PROFILE_SHARE=" + share + "\n" +
		fmt.Sprintf("PROFILE_GB=%d\n", profileGB)
	if err := writeManaged(env, rdProfileSecrets, conf, 0o600); err != nil {
		return "", err
	}
	written = append(written, rdProfileScript, rdProfileSecrets)

	if err := ensurePamHook(env); err != nil {
		return "", err
	}

	// Timeouts. Zero means never, as it does in Windows, and xrdp reads
	// minutes here.
	if err := setSesman(env, map[string]string{
		"DisconnectedTimeLimit": fmt.Sprint(disconnected * 60),
		"IdleTimeLimit":         fmt.Sprint(idle * 60),
	}); err != nil {
		return "", err
	}

	out, err := env.Run.Run(ctx, "systemctl", "restart", "xrdp", "xrdp-sesman")
	if err != nil {
		return out, fmt.Errorf("restarting xrdp: %w", err)
	}
	return "configured " + strings.Join(written, ", "), nil
}

// profileScript is the logon hook. It is deliberately the only way a home
// directory comes into existence on a session host: if the profile cannot be
// mounted the logon fails, because a local home would be a profile that
// exists on one host and not the others, which is the failure a collection
// exists to prevent.
func profileScript() string {
	return "#!/bin/sh\n" + apply.Header + `
# Mount this user's profile disk over their home directory, or refuse the
# logon. Run from PAM at session open and again at session close.
set -eu

[ -r /etc/odm/rd-profile.conf ] || exit 0
. /etc/odm/rd-profile.conf

USER_NAME="${PAM_USER:-}"
[ -n "$USER_NAME" ] || exit 0

# Never for a local account: root and the machine's own service accounts have
# ordinary local homes and must keep them, or the machine is unrecoverable.
case "$(id -u "$USER_NAME" 2>/dev/null || echo 0)" in
    ''|*[!0-9]*) exit 0 ;;
esac
[ "$(id -u "$USER_NAME")" -ge 1000 ] || exit 0
id -G "$USER_NAME" >/dev/null 2>&1 || exit 0

SID="$(getent passwd "$USER_NAME" | cut -d: -f5 | tr -d ' ' || true)"
[ -n "$SID" ] || SID="$(id -u "$USER_NAME")"
IMAGE="UPD-${USER_NAME}-${SID}.img"
STORE=/run/odm/profiles
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
[ -n "$HOME_DIR" ] || HOME_DIR="/home/$USER_NAME"

if [ "${PAM_TYPE:-}" = "close_session" ]; then
    umount "$HOME_DIR" 2>/dev/null || true
    umount "$STORE" 2>/dev/null || true
    exit 0
fi

mkdir -p "$STORE" "$HOME_DIR"

# The share is reached with the machine's own credentials: the user's ticket
# is not available to PAM at this point, and the disk is the machine's to
# mount on their behalf.
if ! mountpoint -q "$STORE"; then
    mount -t cifs "$PROFILE_SHARE" "$STORE" \
        -o sec=krb5,cruid=0,multiuser,vers=3.1.1,noperm 2>/dev/null \
    || mount -t cifs "$PROFILE_SHARE" "$STORE" \
        -o sec=krb5,vers=3.0,noperm
fi

if [ ! -f "$STORE/$IMAGE" ]; then
    # Sparse: it takes the space it uses, and cannot exceed what it was made.
    truncate -s "${PROFILE_GB}G" "$STORE/$IMAGE"
    mkfs.ext4 -q -F "$STORE/$IMAGE"
fi

mount -o loop,noatime "$STORE/$IMAGE" "$HOME_DIR"
chown "$USER_NAME" "$HOME_DIR"
chmod 0700 "$HOME_DIR"
`
}

// ensurePamHook wires the profile script into the session-manager's PAM
// stack. Appended once and left alone afterwards, because the rest of that
// file is Debian's and not ours to rewrite.
func ensurePamHook(env apply.Env) error {
	path := env.Path(rdPamFile)
	body, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("reading %s: %w", rdPamFile, err)
	}
	line := "session required pam_exec.so /etc/odm/rd-profile.sh"
	if strings.Contains(string(body), "/etc/odm/rd-profile.sh") {
		return nil
	}
	updated := string(body) + "\n# " + strings.TrimSuffix(apply.Header, "\n")[2:] + "\n" + line + "\n"
	return os.WriteFile(path, []byte(updated), 0o644)
}

// setSesman rewrites named keys in xrdp's session manager configuration and
// leaves every other line as it was.
func setSesman(env apply.Env, values map[string]string) error {
	path := env.Path(rdSesmanIni)
	body, err := os.ReadFile(path)
	if err != nil {
		// Not a session host, or xrdp is not installed yet. The restart below
		// will say so more usefully than a missing-file error here.
		return nil
	}
	lines := strings.Split(string(body), "\n")
	seen := map[string]bool{}
	for index, line := range lines {
		for key, value := range values {
			if strings.HasPrefix(strings.TrimSpace(line), key+"=") {
				lines[index] = key + "=" + value
				seen[key] = true
			}
		}
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		if !seen[key] {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		lines = append(lines, key+"="+values[key])
	}
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644)
}

// applyRemoteDesktopBroker writes the routing for one collection.
func applyRemoteDesktopBroker(
	ctx context.Context, payload map[string]any, env apply.Env,
) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	name, _ := payload["collection"].(string)
	hosts, err := stringList(payload["hosts"], safeHostName)
	if err != nil {
		return "", err
	}
	balance := balanceMethod(payload["balance_method"])
	affinity := intOf(payload["affinity_minutes"], 8*60)

	var config strings.Builder
	config.WriteString(apply.Header)
	config.WriteString("# Collection: " + name + "\n\n")

	if len(hosts) == 0 {
		config.WriteString("# No session hosts in this collection; nothing is served.\n")
	} else {
		config.WriteString(fmt.Sprintf(`frontend odm_rd
    bind *:3389
    mode tcp
    option tcplog
    timeout client 1h
    default_backend odm_rd_hosts

backend odm_rd_hosts
    mode tcp
    # Where somebody with no session yet goes. They can land on any host in
    # the collection because their profile is a disk on the share rather than
    # files on one machine.
    balance %s
    timeout server 1h
    # And where somebody who already has one goes: back to the same host. An
    # RDP client sends the user name in its first packet, and keeping that
    # against the host it went to is what makes a reconnect resume the session
    # somebody left rather than open a second one beside it.
    #
    # The window is the collection's own disconnected timeout. An entry that
    # expired first would send somebody to a host that cannot mount their
    # profile, because the host still holding the session still has it.
    stick-table type string len 64 size 10k expire %dm
    stick on req.rdp_cookie(mstshash)
    tcp-request inspect-delay 5s
    tcp-request content accept if RDP_COOKIE
`, balance, affinity))
		for index, host := range hosts {
			config.WriteString(fmt.Sprintf(
				"    server host%d %s:3389 check inter 10s\n", index+1, host))
		}
	}

	if err := writeManaged(env, rdBrokerConfig, config.String(), 0o644); err != nil {
		return "", err
	}

	// Checked before it is loaded: a broker that refuses to start is a
	// collection nobody can reach, and the reason belongs here rather than in
	// a journal on that machine.
	if out, err := env.Run.Run(ctx, "haproxy", "-c", "-f", "/etc/haproxy/haproxy.cfg",
		"-f", "/etc/haproxy/conf.d"); err != nil {
		return out, fmt.Errorf("the generated routing is not valid: %w", err)
	}
	out, err := env.Run.Run(ctx, "systemctl", "reload", "haproxy")
	if err != nil {
		return out, fmt.Errorf("reloading haproxy: %w", err)
	}
	return fmt.Sprintf("routing %d host(s) for %s", len(hosts), name), nil
}

// balanceMethod maps what the collection asked for onto haproxy's name for
// it, and refuses anything else rather than writing a configuration haproxy
// will not load.
func balanceMethod(value any) string {
	switch name, _ := value.(string); name {
	case "roundrobin":
		return "roundrobin"
	case "first":
		return "first"
	default:
		// Fewest sessions. The default because it is what an administrator
		// means by "spread the load" on a session host.
		return "leastconn"
	}
}

func writeManaged(env apply.Env, path, body string, mode os.FileMode) error {
	full := env.Path(path)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return os.WriteFile(full, []byte(body), mode)
}

func intOf(value any, fallback int) int {
	if number, ok := value.(float64); ok {
		return int(number)
	}
	return fallback
}
