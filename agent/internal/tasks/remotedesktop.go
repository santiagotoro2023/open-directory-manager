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
	rdStartWM        = "/etc/xrdp/startwm.sh"
	rdSessionScript  = "/etc/odm/rd-session.sh"
	rdProfileScript  = "/etc/odm/rd-profile.sh"
	rdProfileSecrets = "/etc/odm/rd-profile.conf"
	rdPamFile        = "/etc/pam.d/xrdp-sesman"
	rdBrokerConfig   = "/etc/haproxy/conf.d/odm-remote-desktop.cfg"
	rdSesmanIni      = "/etc/xrdp/sesman.ini"
	rdXrdpIni        = "/etc/xrdp/xrdp.ini"
	// What the role installer recorded about this host, including which
	// desktop it was given.
	sessionHostConf = "/etc/odm/session-host.conf"
)

var (
	// //server/share, and optionally a path within it. %username% is
	// substituted at logon, so one collection gives everybody their own.
	safeShare = regexp.MustCompile(
		`^//[A-Za-z0-9._-]+/[A-Za-z0-9._$ -]{1,64}(/[A-Za-z0-9._$% -]{1,64})*$`)
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
	// An empty share is a collection without roaming profiles: every session
	// keeps whatever home the host already gives the user. It is the right
	// default for a single session host, and it means remote desktop does not
	// need a file server before it works at all.
	share, _ := payload["profile_share"].(string)
	share = strings.TrimRight(share, "/")
	if share != "" && !safeShare.MatchString(share) {
		return "", fmt.Errorf("invalid profile share %q", share)
	}
	for _, part := range strings.Split(share, "/") {
		if part == "." || part == ".." {
			return "", fmt.Errorf("invalid profile share %q", share)
		}
	}
	kind, _ := payload["kind"].(string)
	appPath, _ := payload["app_path"].(string)
	if kind == "remoteapp" && !safeAppPath.MatchString(appPath) {
		return "", fmt.Errorf("invalid published application %q", appPath)
	}
	profileGB := intOf(payload["profile_gb"], 10)
	allowLocalHome := "no"
	if local, ok := payload["allow_local_home"].(bool); ok && local {
		allowLocalHome = "yes"
	}
	idle := intOf(payload["idle_minutes"], 0)
	disconnected := intOf(payload["disconnected_minutes"], 0)

	var written []string

	// What a session runs, when it is not the machine's own desktop. A
	// published application replaces the desktop rather than sitting on top
	// of one: closing it ends the session, which is what somebody handed a
	// single application expects.
	//
	// A full desktop has no script of its own. It used to have one, and that
	// script said startxfce4 whatever desktop the host had been installed
	// with — so a GNOME session host put into a collection served a black
	// screen for a few seconds and then dropped the connection, because the
	// desktop it was told to start was not installed on it.
	if kind == "remoteapp" {
		session := "#!/bin/sh\n" + apply.Header +
			"# Published application. Closing it ends the session.\n" +
			"exec " + appPath + "\n"
		if err := writeManaged(env, rdSessionScript, session, 0o755); err != nil {
			return "", err
		}
		written = append(written, rdSessionScript)
	} else if err := os.Remove(env.Path(rdSessionScript)); err != nil && !os.IsNotExist(err) {
		return "", err
	}

	// And how it is started. The role installer writes this too, but a host
	// installed before the fix keeps its old copy for ever otherwise — and
	// the old copy ran the desktop with none of a session's environment, so
	// every connection ended at "Unable to determine failsafe session name".
	if err := writeManaged(env, rdStartWM, startWM(env), 0o755); err != nil {
		return "", err
	}
	written = append(written, rdStartWM)

	// The profile disk, and the fact that there is no alternative to it.
	if err := writeManaged(env, rdProfileScript, profileScript(), 0o755); err != nil {
		return "", err
	}
	conf := apply.Header +
		"PROFILE_SHARE=" + share + "\n" +
		fmt.Sprintf("PROFILE_GB=%d\n", profileGB) +
		fmt.Sprintf("ALLOW_LOCAL_HOME=%s\n", allowLocalHome)
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

	// Where xrdp listens. The broker owns 3389, so a machine that is both a
	// broker and a host moves xrdp aside: on one machine they both bound
	// 3389, xrdp won, and haproxy exited with "cannot bind socket (Address
	// already in use)" — the broker was not brokering at all.
	port := intOf(payload["rdp_port"], 3389)
	if port < 1 || port > 65535 {
		return "", fmt.Errorf("invalid rdp port %d", port)
	}
	if err := setXrdpPort(env, port); err != nil {
		return "", err
	}

	out, err := env.Run.Run(ctx, "systemctl", "restart", "xrdp", "xrdp-sesman")
	if err != nil {
		return out, fmt.Errorf("restarting xrdp: %w", err)
	}
	return "configured " + strings.Join(written, ", "), nil
}

// startWM is what xrdp runs once a session has been authenticated.
//
// Through /etc/X11/Xsession, which is what makes a Debian graphical session:
// XDG_CONFIG_DIRS, XDG_DATA_DIRS, the D-Bus session bus. Started without it,
// xfce4-session cannot find its own defaults under /etc/xdg and every
// connection ends at "Unable to load a failsafe session".
func startWM(env apply.Env) string {
	desktop, command, name := hostDesktop(env)
	graphics := ""
	if desktop != "xfce" {
		// A server has no graphics card, and both GNOME Shell and Plasma want
		// a GL context. Mesa's software renderer provides one.
		graphics = "LIBGL_ALWAYS_SOFTWARE=1\nexport LIBGL_ALWAYS_SOFTWARE\n"
	}
	return "#!/bin/sh\n" + apply.Header + `
if [ -r /etc/profile ]; then
    . /etc/profile
fi

# What the session tells applications it is. A desktop that cannot answer that
# starts without its panel, its settings or the policy that rides on them.
XDG_SESSION_TYPE=x11
XDG_CURRENT_DESKTOP=` + name + `
export XDG_SESSION_TYPE XDG_CURRENT_DESKTOP
` + graphics + `
if [ -x ` + rdSessionScript + ` ]; then
    exec /etc/X11/Xsession ` + rdSessionScript + `
fi

# The desktop this host was installed with, then whatever else is installed.
# A session host whose desktop package is missing used to serve a black screen
# and drop the connection; this way it serves the desktop it has.
for session in ` + strings.Join(sessionOrder(command), " ") + `; do
    if command -v "$session" >/dev/null 2>&1; then
        exec /etc/X11/Xsession "$session"
    fi
done
echo "no desktop session is installed on this host" >&2
exit 1
`
}

// sessionOrder is the desktop this host was installed with, then the others,
// each named once.
func sessionOrder(first string) []string {
	order := []string{first}
	for _, other := range []string{"gnome-session", "startplasma-x11", "startxfce4"} {
		if other != first {
			order = append(order, other)
		}
	}
	return order
}

// hostDesktop is what the session-host role was installed with, which decides
// what a full desktop means on this machine. A host installed before the
// choice existed has no record and had XFCE.
func hostDesktop(env apply.Env) (desktop, command, name string) {
	body, err := os.ReadFile(env.Path(sessionHostConf))
	desktop = "xfce"
	if err == nil {
		for _, line := range strings.Split(string(body), "\n") {
			if value, found := strings.CutPrefix(strings.TrimSpace(line), "DESKTOP="); found {
				desktop = strings.Trim(strings.TrimSpace(value), `"`)
			}
		}
	}
	switch desktop {
	case "gnome":
		return desktop, "gnome-session", "GNOME"
	case "plasma":
		return desktop, "startplasma-x11", "KDE"
	default:
		return "xfce", "startxfce4", "XFCE"
	}
}

// profileScript is the logon hook. It is deliberately the only way a home
// directory comes into existence on a session host: if the profile cannot be
// mounted the logon fails, because a local home would be a profile that
// exists on one host and not the others, which is the failure a collection
// exists to prevent.
func profileScript() string {
	return "#!/bin/sh\n" + apply.Header + `
# Mount this user's profile disk over their home directory. Run from PAM at
# session open and again at session close.
#
# What happens when the disk cannot be attached — the share was renamed, the
# file server is down, the ticket was refused — is the collection's decision.
#
# Refusing is the default. The session manager reports it as "Can't create
# session for user", which is blunt, but the alternative is worse: a local
# home is a profile that exists on this host and nowhere else, so somebody
# given one silently stops keeping their work where they think it is, and
# nothing tells them until they land on another host and it is not there.
#
# Allow local homes turns that round, for a collection that would rather stay
# reachable while a file server is down. Either way the reason is in the
# journal under odm-rd-profile.
# PAM runs this with almost no environment. An unset PATH means mkdir, chown
# and mount are all "not found", and the home directory this was supposed to
# make somebody's own stays root's — which stops their X server starting.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

set -u

warn() {
    logger -t odm-rd-profile "$1"
    if [ "${ALLOW_LOCAL_HOME:-no}" = "yes" ]; then
        logger -t odm-rd-profile "${USER_NAME:-that session} gets a local home"
        exit 0
    fi
    # Refused. The disk is the profile: starting without it hands somebody a
    # home that is not theirs anywhere else.
    exit 1
}

[ -r /etc/odm/rd-profile.conf ] || {
    logger -t odm-rd-profile "no collection settings on this host; nothing to mount"
    exit 0
}
. /etc/odm/rd-profile.conf
[ -n "${PROFILE_SHARE:-}" ] || {
    # A collection with no profile share. Said out loud, because "no profile
    # disk was created" and "this collection was never given a share" look
    # identical from the console otherwise.
    logger -t odm-rd-profile "this collection has no profile share; using the host's own home"
    exit 0
}

USER_NAME="${PAM_USER:-}"
[ -n "$USER_NAME" ] || exit 0

# Never for a local account: root and the machine's own service accounts have
# ordinary local homes and must keep them, or the machine is unrecoverable.
USER_ID="$(id -u "$USER_NAME" 2>/dev/null || echo 0)"
case "$USER_ID" in
    ''|*[!0-9]*) exit 0 ;;
esac
[ "$USER_ID" -ge 1000 ] || exit 0

# Named for the account and nothing else, so the same person gets the same
# disk here as a roaming-profile policy gives them on an ordinary desktop.
# A uid does not travel between machines; a name does.
LOWER_NAME="$(printf '%s' "$USER_NAME" | tr 'A-Z' 'a-z')"
IMAGE="UPD-$LOWER_NAME.img"
STORE=/run/odm/profiles
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
[ -n "$HOME_DIR" ] || HOME_DIR="/home/$USER_NAME"

if [ "${PAM_TYPE:-}" = "close_session" ]; then
    if mountpoint -q "$HOME_DIR"; then
        # Lazy as the fallback: the session manager closes the PAM session
        # before the last of the user's processes has gone, so a plain umount
        # answers "target is busy" and the disk stays attached until the next
        # reboot — which is how somebody who signed out an hour ago still had
        # a home directory on the host.
        umount "$HOME_DIR" 2>/dev/null || umount -l "$HOME_DIR" 2>/dev/null ||
            logger -t odm-rd-profile "could not detach $USER_NAME's profile disk"
    fi
    # And the mount point with it. rmdir removes an empty directory and
    # nothing else, so a home that is still mounted, or one holding files
    # because the disk never attached, is left exactly as it is. Without this
    # every person who has ever signed in leaves a local /home entry behind,
    # which is the thing a profile disk exists to avoid.
    rmdir "$HOME_DIR" 2>/dev/null || true
    # The share only when nobody else on this host still has a profile on it:
    # unmounted unconditionally, the first person to sign out took the store
    # away from everybody still working.
    grep -q " $STORE/\? " /proc/mounts && ! grep -q " /home/" /proc/mounts \
        && umount "$STORE" 2>/dev/null
    exit 0
fi

# The share is what gets mounted; anything after it is a directory inside it,
# made if it is not there. mount.cifs will not create one, and a per-person
# path is the whole point of %username%.
SHARE="$(printf '%s' "$PROFILE_SHARE" | sed "s|%username%|$LOWER_NAME|g")"
REST="${SHARE#//}"
MOUNT_SRC="//$(printf '%s' "$REST" | cut -d/ -f1,2)"
SUB=""
case "$REST" in */*/*) SUB="$(printf '%s' "$REST" | cut -d/ -f3-)" ;; esac
case "$SUB" in *..*) warn "$PROFILE_SHARE may not contain .." ;; esac

# A roaming-profile policy runs from the ordinary session hook, which is in
# this PAM stack too. Whichever got there first, the profile is attached.
mountpoint -q "$HOME_DIR" && exit 0

# The store is root's alone. It holds everybody's profile disks, and a mode
# anybody could walk would let one person read another's whole profile.
mkdir -p "$STORE" "$HOME_DIR" 2>/dev/null || warn "cannot create $HOME_DIR"
chmod 0700 "$STORE" 2>/dev/null || true
# Theirs from the moment it exists. Made by root and left that way, nothing in
# their session can write to it — including the X server, which then does not
# start at all.
chown "$USER_ID:$(id -g "$USER_NAME")" "$HOME_DIR" 2>/dev/null ||
    logger -t odm-rd-profile "could not give $HOME_DIR to $USER_NAME"
chmod 0700 "$HOME_DIR" 2>/dev/null || true

# The share is reached with the machine's own ticket and multiuser, which is
# what a machine several people sign in to needs: the mount belongs to the
# host and each session reaches its own profile with its own credentials.
#
# root has no ticket of its own until it is asked for one. Without this the
# mount was attempted with nothing to authenticate as, answered "could not be
# mounted", and — a profile disk being the whole home — every session on a
# collection with a profile share was refused.
if ! mountpoint -q "$STORE"; then
    klist -s 2>/dev/null || kinit -k 2>/dev/null || true
    for OPTIONS in "sec=krb5,cruid=0,multiuser,vers=3.1.1,noperm" \
                   "sec=krb5,cruid=$USER_ID,vers=3.1.1,noperm" \
                   "sec=krb5,cruid=$USER_ID,vers=3.0,noperm"; do
        mount -t cifs "$MOUNT_SRC" "$STORE" -o "$OPTIONS" 2>/dev/null && break
    done
    mountpoint -q "$STORE" || warn "$MOUNT_SRC could not be mounted for $USER_NAME"
fi

TARGET="$STORE"
if [ -n "$SUB" ]; then
    TARGET="$STORE/$SUB"
    mkdir -p "$TARGET" 2>/dev/null || warn "could not create $SUB on $MOUNT_SRC"
fi

if [ ! -f "$TARGET/$IMAGE" ]; then
    # Sparse: it takes the space it uses, and cannot exceed what it was made.
    truncate -s "${PROFILE_GB}G" "$TARGET/$IMAGE" 2>/dev/null \
        && mkfs.ext4 -q -F "$TARGET/$IMAGE" 2>/dev/null \
        || warn "could not create a profile disk for $USER_NAME on $PROFILE_SHARE"
fi

mount -o loop,noatime "$TARGET/$IMAGE" "$HOME_DIR" 2>/dev/null \
    || warn "could not attach $USER_NAME's profile disk"
chown "$USER_ID:$(id -g "$USER_NAME")" "$HOME_DIR"
chmod 0700 "$HOME_DIR"

# A brand new disk gets the same starting point a brand new local home gets.
# Without it the first session lands in an empty directory and the desktop
# comes up with none of its defaults — no XDG directories, no dconf, nothing.
# lost+found alone is a freshly made filesystem.
if [ "$(ls -A "$HOME_DIR" 2>/dev/null | grep -vc '^lost+found$')" = "0" ]; then
    cp -a /etc/skel/. "$HOME_DIR/" 2>/dev/null || true
    chown -R "$USER_ID:$(id -g "$USER_NAME")" "$HOME_DIR" 2>/dev/null || true
fi
`
}

// ensurePamHook wires the profile script into the session-manager's PAM
// stack. Appended once and left alone afterwards, because the rest of that
// file is Debian's and not ours to rewrite.
// ensurePamHook puts the profile hook into the remote desktop session stack,
// before the module that would otherwise make a home directory first.
//
// Appended at the end it ran after pam_mkhomedir, which had already created
// and seeded a local home: the profile disk was then mounted over the top,
// and detaching it at sign-out revealed the local copy again. Every person
// who ever signed in left a home directory on every host they touched, which
// is exactly what a profile disk exists to avoid.
func ensurePamHook(env apply.Env) error {
	path := env.Path(rdPamFile)
	body, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("reading %s: %w", rdPamFile, err)
	}
	line := "session required pam_exec.so " + rdProfileScript
	comment := "# " + strings.TrimSuffix(apply.Header, "\n")[2:]

	kept := []string{}
	for _, existing := range strings.Split(string(body), "\n") {
		// Any earlier copy of ours, wherever it was put, and the comment
		// above it. A host configured before this is repaired rather than
		// left with the line in the place that did not work.
		if strings.Contains(existing, rdProfileScript) || existing == comment {
			continue
		}
		kept = append(kept, existing)
	}

	// pam_mkhomedir is usually reached through common-session, so the include
	// is what has to be preceded; a stack naming the module directly is
	// handled too.
	at := len(kept)
	for index, existing := range kept {
		trimmed := strings.TrimSpace(existing)
		if strings.HasPrefix(trimmed, "@include common-session") ||
			strings.Contains(trimmed, "pam_mkhomedir.so") {
			at = index
			break
		}
	}
	updated := append([]string{}, kept[:at]...)
	updated = append(updated, comment, line)
	updated = append(updated, kept[at:]...)
	return os.WriteFile(path, []byte(strings.Join(updated, "\n")), 0o644)
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
	hosts, err := brokerHosts(payload["hosts"])
	if err != nil {
		return "", err
	}
	peers, err := peerNames(payload["brokers"])
	if err != nil {
		return "", err
	}
	balance := balanceMethod(payload["balance_method"])
	affinity := intOf(payload["affinity_minutes"], 8*60)

	var config strings.Builder
	config.WriteString(apply.Header)
	config.WriteString("# Collection: " + name + "\n\n")

	// Two brokers keeping one table between them. Without it each keeps its
	// own, and somebody reconnecting through the standby is sent to a host by
	// load rather than to the one still holding their session — which refuses
	// the logon, because their profile disk is mounted on the other host.
	shared := ""
	if len(peers) > 1 {
		config.WriteString("peers odm_rd\n")
		for _, peer := range peers {
			fmt.Fprintf(&config, "    peer %s %s:%d\n", peer.Name, peer.Host, peerPort)
		}
		config.WriteString("\n")
		shared = " peers odm_rd"
	}

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
    stick-table type string len 64 size 10k expire %dm%s
    stick on req.rdp_cookie(mstshash)
    tcp-request inspect-delay 5s
    tcp-request content accept if RDP_COOKIE
`, balance, affinity, shared))
		for index, host := range hosts {
			// A drained host keeps the sessions it has and takes no new ones.
			// Weight zero is how that is said in a configuration file: the
			// load balancer skips it, and a stick-table entry still sends
			// somebody back to it. Removing it from the collection instead
			// would send everybody still on it elsewhere at their next
			// reconnect, which is the opposite of draining.
			weight := ""
			if !host.AcceptsNew {
				weight = " weight 0"
			}
			config.WriteString(fmt.Sprintf(
				"    server host%d %s:%d check inter 10s%s\n",
				index+1, host.Name, host.Port, weight))
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
	// A reload keeps the sessions haproxy is already carrying, which is the
	// point of a broker — so it is tried first.
	out, err := env.Run.Run(ctx, "systemctl", "reload", "haproxy")
	if err != nil {
		return out, fmt.Errorf("reloading haproxy: %w", err)
	}

	// But a reload cannot rescue a master process whose last load failed: it
	// says "Resumed frontend GLOBAL" and carries on serving nothing. That is
	// exactly the state a port clash leaves behind, so make sure the
	// frontend is actually bound and restart if it is not.
	if len(hosts) > 0 && !haproxyListening(ctx, env, brokerPort) {
		if out, err := env.Run.Run(ctx, "systemctl", "restart", "haproxy"); err != nil {
			return out, fmt.Errorf("haproxy would not start: %w", err)
		}
		if !haproxyListening(ctx, env, brokerPort) {
			return out, fmt.Errorf(
				"haproxy is running but nothing is listening on %d; check its journal",
				brokerPort,
			)
		}
	}
	return fmt.Sprintf("routing %d host(s) for %s", len(hosts), name), nil
}

// The port clients connect to. The broker owns it; a session host on the same
// machine is moved aside by the control plane.
const brokerPort = 3389

// haproxyListening reports whether haproxy itself holds the port.
//
// Not "anything holds it": on a machine that is also a session host, xrdp
// still had 3389 at the moment the broker was configured, so a check for the
// port alone said yes, no restart happened, and when xrdp moved aside nothing
// took the port back.
func haproxyListening(ctx context.Context, env apply.Env, port int) bool {
	out, err := env.Run.Run(ctx, "ss", "-lntp")
	if err != nil {
		// No ss is not evidence either way; assume it came up rather than
		// restarting a working broker on every refresh.
		return true
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, fmt.Sprintf(":%d ", port)) &&
			strings.Contains(line, "haproxy") {
			return true
		}
	}
	return false
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

// brokerHost is one session host and the port its xrdp answers on. A host that
// shares a machine with the broker is moved aside, because the broker owns
// 3389 there.
type brokerHost struct {
	Name string
	Port int
	// Whether it is taking new sessions. A host being patched is drained
	// rather than removed, so the people still on it keep their sessions.
	AcceptsNew bool
}

// Where two brokers talk to each other about who is on which host. Its own
// port, because the one clients use carries RDP and nothing else.
const peerPort = 10389

type brokerPeer struct {
	Name string
	Host string
}

// peerNames is the brokers fronting this collection, named as haproxy needs
// them: a peers section identifies the local node by matching a peer name
// against the machine's own host name, so the short name is what goes here.
func peerNames(value any) ([]brokerPeer, error) {
	raw, ok := value.([]any)
	if !ok {
		return nil, nil
	}
	peers := make([]brokerPeer, 0, len(raw))
	for _, item := range raw {
		host := str(item)
		if entry, ok := item.(map[string]any); ok {
			host = str(entry["host"])
		}
		if !safeHostName.MatchString(host) {
			return nil, fmt.Errorf("invalid broker name %q", host)
		}
		peers = append(peers, brokerPeer{Name: shortName(host), Host: host})
	}
	return peers, nil
}

func shortName(host string) string {
	name, _, _ := strings.Cut(host, ".")
	return name
}

func brokerHosts(value any) ([]brokerHost, error) {
	raw, ok := value.([]any)
	if !ok {
		return nil, nil
	}
	hosts := make([]brokerHost, 0, len(raw))
	for _, item := range raw {
		entry, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("a host is not an object")
		}
		name := str(entry["host"])
		if !safeHostName.MatchString(name) {
			return nil, fmt.Errorf("invalid host name %q", name)
		}
		port := intOf(entry["port"], 3389)
		if port < 1 || port > 65535 {
			return nil, fmt.Errorf("invalid port %d for %s", port, name)
		}
		accepts := true
		if value, ok := entry["accepts_new"].(bool); ok {
			accepts = value
		}
		hosts = append(hosts, brokerHost{Name: name, Port: port, AcceptsNew: accepts})
	}
	return hosts, nil
}

// setXrdpPort rewrites the listening port in xrdp.ini, leaving the rest of
// the file alone: it is the machine's own configuration, not ODM's.
func setXrdpPort(env apply.Env, port int) error {
	path := env.Path(rdXrdpIni)
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	lines := strings.Split(string(body), "\n")
	wanted := fmt.Sprintf("port=%d", port)
	// Only the one in [Globals], which is the first: the others belong to
	// channel definitions and are -1 on purpose.
	for index, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "port=") {
			if strings.TrimSpace(line) == wanted {
				return nil
			}
			lines[index] = wanted
			break
		}
	}
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644)
}
