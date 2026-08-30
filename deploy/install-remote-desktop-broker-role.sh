#!/usr/bin/env bash
# Install the remote desktop broker role.
#
# The broker is the address people connect to. It routes each connection to a
# session host and, critically, sends the same person back to the same host
# every time — which is what makes a reconnect resume the session they left
# rather than start a new one beside it.
#
# That routing is haproxy in TCP mode. RDP clients send the user name in the
# initial packet as a cookie ("mstshash"), haproxy can read it, and a stick
# table on that value is exactly the affinity a Windows connection broker
# provides. No new network code, and no protocol implemented here.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

# Shared helpers: apt that survives a controller, and a dpkg that recovers.
# shellcheck source=odm-role-common.sh
. "$(dirname "$0")/odm-role-common.sh"

odm_apt_install haproxy

install -d -m 0755 /etc/odm

# A placeholder that refuses connections rather than dropping them silently.
# The real configuration arrives with the first collection.
if [[ ! -f /etc/haproxy/conf.d/odm-remote-desktop.cfg ]]; then
    install -d -m 0755 /etc/haproxy/conf.d
    cat > /etc/haproxy/conf.d/odm-remote-desktop.cfg <<'CFG'
# Managed by Open Directory Manager. Local edits are overwritten.
# No collection has been assigned to this broker yet.
CFG
fi

# Debian's unit reads one file. Point it at a directory so ODM owns its own
# fragment and leaves whatever else is on the machine alone.
install -d -m 0755 /etc/systemd/system/haproxy.service.d
cat > /etc/systemd/system/haproxy.service.d/odm.conf <<'UNIT'
# Managed by Open Directory Manager. Local edits are overwritten.
[Service]
ExecStart=
ExecStart=/usr/sbin/haproxy -Ws -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/conf.d \
    -p /run/haproxy.pid $EXTRAOPTS
UNIT

odm_enable haproxy

cat <<SUMMARY

Remote desktop broker installed.

  Listening   3389/tcp (once a collection has hosts)

Create a collection under Remote Desktop and give it session hosts. People
connect to this machine's name, not to a host's.
SUMMARY
