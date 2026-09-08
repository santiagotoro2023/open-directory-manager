#!/usr/bin/env bash
# Install the remote desktop session host role.
#
# A session host serves desktops over RDP to domain accounts. It deliberately
# configures almost nothing here: which desktop people get, who may connect,
# where their profile lives and when a session ends are the collection's, and
# arrive as a task once the machine is put in one. What is set here is what is
# true of the machine whatever collection it ends up in.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

# Shared helpers: apt that survives a controller, and a dpkg that recovers.
# shellcheck source=odm-role-common.sh
. "$(dirname "$0")/odm-role-common.sh"

[[ -f /etc/krb5.keytab ]] || {
    echo "not domain-joined: a session host authenticates domain accounts" >&2
    exit 1
}

# Which desktop people get when they connect. XFCE is the default because it
# is what a server can serve to the most people at once; GNOME is what a
# Debian desktop client runs, so a remote session looks like the machine
# somebody left rather than a different product.
DESKTOP="xfce"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --desktop) DESKTOP="${2:?}"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
case "$DESKTOP" in
    xfce|gnome|plasma) ;;
    *) echo "--desktop must be xfce, gnome or plasma" >&2; exit 2 ;;
esac

# Debian 12 calls it policykit-1 and Debian 13 calls it polkitd. Chosen from
# the archive rather than tried and retried: a failed install prints its own
# reason loudly, and an operator should not have to work out that the first of
# two attempts was expected to fail.
# "Candidate:" rather than "show": trixie still lists policykit-1 in the
# index and has no version of it to install.
POLKIT="polkitd"
apt-cache policy policykit-1 2>/dev/null | grep -q 'Candidate: [^(]' && POLKIT="policykit-1"

# One session per desktop, and the command that starts it. A published
# application replaces this through the collection; this is what a full
# desktop means on this machine.
# DESKTOP_NAME is what the session tells applications it is; a desktop that
# cannot answer that starts without its panel, its settings or its policy.
case "$DESKTOP" in
    xfce)
        DESKTOP_PACKAGES=(xfce4 xfce4-goodies xfce4-terminal)
        SESSION_COMMAND="startxfce4"
        DESKTOP_NAME="XFCE"
        ;;
    gnome)
        # The session, the shell and the applications somebody expects to find
        # — not task-gnome-desktop, which also pulls a display manager for a
        # machine nobody sits at, a printing stack and a set of games.
        # dconf-cli is what the desktop-background, dash and screen-lock
        # settings are written through, so a GNOME session host applies them
        # exactly as a GNOME client does.
        DESKTOP_PACKAGES=(gnome-session gnome-shell gnome-terminal nautilus
                          gnome-control-center gnome-text-editor
                          gnome-system-monitor dconf-cli)
        SESSION_COMMAND="gnome-session"
        DESKTOP_NAME="GNOME"
        ;;
    plasma)
        DESKTOP_PACKAGES=(plasma-desktop plasma-workspace konsole dolphin
                          systemsettings)
        SESSION_COMMAND="startplasma-x11"
        DESKTOP_NAME="KDE"
        ;;
esac

# A server has no graphics card, and GNOME Shell and Plasma both want a GL
# context. Mesa's software renderer provides one; saying so explicitly is the
# difference between a session that starts and a black window on hardware that
# offers a partial GL.
GRAPHICS_FALLBACK=""
if [[ "$DESKTOP" != "xfce" ]]; then
    GRAPHICS_FALLBACK=$'LIBGL_ALWAYS_SOFTWARE=1\nexport LIBGL_ALWAYS_SOFTWARE'
fi

WANTED=(xrdp xorgxrdp openssl cifs-utils keyutils dbus-x11 "$POLKIT"
        "${DESKTOP_PACKAGES[@]}")

# Which of them were missing before this ran, which is exactly the set
# uninstalling the role may take away again.
NEWLY_INSTALLED=()
for PACKAGE in "${WANTED[@]}"; do
    dpkg-query -W -f='${Status}' "$PACKAGE" 2>/dev/null | grep -q "^install ok installed" \
        || NEWLY_INSTALLED+=("$PACKAGE")
done

odm_apt_install "${WANTED[@]}"

install -d -m 0755 /etc/odm

# What this machine was given, so removing the role removes that desktop and
# not one somebody had before it. Only packages this run actually installed:
# a machine that was already a GNOME desktop keeps GNOME when the role goes.
{
    echo "# Managed by Open Directory Manager. Local edits are overwritten."
    echo "DESKTOP=$DESKTOP"
    echo "INSTALLED=\"${NEWLY_INSTALLED[*]}\""
} > /etc/odm/session-host.conf
chmod 0644 /etc/odm/session-host.conf

# xrdp runs each session as the user who signed in, and that user is a domain
# account resolved by SSSD. Nothing here grants access: PAM decides, and the
# collection decides what PAM is told.
cat > /etc/xrdp/startwm.sh <<WM
#!/bin/sh
# Managed by Open Directory Manager. Local edits are overwritten.
#
# The collection writes /etc/odm/rd-session.sh when it wants something other
# than a full desktop — a published application, for instance. Without it,
# this is an ordinary $DESKTOP session.
#
# Started through /etc/X11/Xsession rather than directly. Xsession is what
# sets up a Debian graphical session — XDG_CONFIG_DIRS, XDG_DATA_DIRS, the
# D-Bus session bus, the keyring — and running the session command without it
# produced
#
#   Unable to load a failsafe session
#   Unable to determine failsafe session name
#
# on every connection: the session could not read its own defaults out of
# /etc/xdg because nothing had told it where /etc/xdg was.
if [ -r /etc/profile ]; then
    . /etc/profile
fi

# What the session tells applications it is. GNOME and Plasma both decide
# which desktop they are running as from these, and dconf, xdg-autostart and
# the policy that rides on them follow the same two variables.
XDG_SESSION_TYPE=x11
XDG_CURRENT_DESKTOP=$DESKTOP_NAME
export XDG_SESSION_TYPE XDG_CURRENT_DESKTOP
$GRAPHICS_FALLBACK

if [ -x /etc/odm/rd-session.sh ]; then
    exec /etc/X11/Xsession /etc/odm/rd-session.sh
fi
exec /etc/X11/Xsession $SESSION_COMMAND
WM
chmod 0755 /etc/xrdp/startwm.sh

# Debian's Xorg wrapper only lets somebody sitting at the machine start an X
# server. A remote desktop session has no console seat, so every connection
# authenticated, asked for a session and got
#
#   [ERROR] waitforx: Unable to open display :11
#   [ERROR] X server failed to start
#
# which the client shows as "Can't create session for user - X server could
# not be started". A session host is a machine whose whole job is starting X
# servers for people who are not at it.
install -d -m 0755 /etc/X11
cat > /etc/X11/Xwrapper.config <<'XWRAPPER'
# Managed by Open Directory Manager. Local edits are overwritten.
allowed_users=anybody
needs_root_rights=yes
XWRAPPER
chmod 0644 /etc/X11/Xwrapper.config

# Colour depth and a session per user rather than per connection: reconnecting
# has to find the session that was left, which is the whole point of a broker
# sending somebody back to the same host.
if [[ -f /etc/xrdp/sesman.ini ]]; then
    cp -a /etc/xrdp/sesman.ini "/etc/xrdp/sesman.ini.pre-odm.$(date +%s)"
    sed -i 's/^MaxSessions=.*/MaxSessions=200/' /etc/xrdp/sesman.ini
    sed -i 's/^KillDisconnected=.*/KillDisconnected=false/' /etc/xrdp/sesman.ini
fi

# The certificate xrdp presents. Replaced by the CA role's issued one when
# there is a certificate authority; self-signed is better than refusing to
# start, and an RDP client warns either way until the root is trusted.
if [[ ! -f /etc/xrdp/cert.pem ]]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
        -keyout /etc/xrdp/key.pem -out /etc/xrdp/cert.pem \
        -subj "/CN=$(hostname -f)" >/dev/null 2>&1
fi
chown root:xrdp /etc/xrdp/key.pem 2>/dev/null || true
chmod 0640 /etc/xrdp/key.pem 2>/dev/null || true

odm_enable xrdp xrdp-sesman

cat <<SUMMARY

Remote desktop session host installed.

  Listening   3389/tcp
  Desktop     $DESKTOP

It serves nobody yet. Add it to a collection under Remote Desktop, which is
where the desktop, the profile share and who may connect are decided.
SUMMARY
