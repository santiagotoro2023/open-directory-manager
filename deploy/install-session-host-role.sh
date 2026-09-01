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

# Debian 12 calls it policykit-1 and Debian 13 calls it polkitd. Chosen from
# the archive rather than tried and retried: a failed install prints its own
# reason loudly, and an operator should not have to work out that the first of
# two attempts was expected to fail.
# "Candidate:" rather than "show": trixie still lists policykit-1 in the
# index and has no version of it to install.
POLKIT="polkitd"
apt-cache policy policykit-1 2>/dev/null | grep -q 'Candidate: [^(]' && POLKIT="policykit-1"

odm_apt_install xrdp xorgxrdp xfce4 xfce4-goodies xfce4-terminal openssl \
    cifs-utils dbus-x11 "$POLKIT"

install -d -m 0755 /etc/odm

# xrdp runs each session as the user who signed in, and that user is a domain
# account resolved by SSSD. Nothing here grants access: PAM decides, and the
# collection decides what PAM is told.
cat > /etc/xrdp/startwm.sh <<'WM'
#!/bin/sh
# Managed by Open Directory Manager. Local edits are overwritten.
#
# The collection writes /etc/odm/rd-session.sh when it wants something other
# than a full desktop — a published application, for instance. Without it,
# this is an ordinary XFCE session.
if [ -r /etc/profile ]; then
    . /etc/profile
fi
if [ -x /etc/odm/rd-session.sh ]; then
    exec /etc/odm/rd-session.sh
fi
exec startxfce4
WM
chmod 0755 /etc/xrdp/startwm.sh

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
  Desktop     XFCE

It serves nobody yet. Add it to a collection under Remote Desktop, which is
where the desktop, the profile share and who may connect are decided.
SUMMARY
