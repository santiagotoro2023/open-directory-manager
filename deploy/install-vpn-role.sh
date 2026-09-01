#!/usr/bin/env bash
# Install the VPN role: WireGuard, for machines and people outside the network.
#
# The role is the server. The tunnels themselves are created under Remote
# Access in the console, which writes each one's configuration through the
# node's agent — so a tunnel can be changed without reinstalling anything.

set -euo pipefail

EXTERNAL_INTERFACE=""

usage() {
    echo "usage: install-vpn-role.sh [--external-interface <iface>]" >&2
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --external-interface) EXTERNAL_INTERFACE="${2:?}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

# Shared helpers: apt that survives a controller, and a dpkg that recovers.
# shellcheck source=odm-role-common.sh
. "$(dirname "$0")/odm-role-common.sh"

[[ -z "$EXTERNAL_INTERFACE" || "$EXTERNAL_INTERFACE" =~ ^[A-Za-z0-9._-]{1,32}$ ]] ||
    { echo "invalid --external-interface" >&2; exit 1; }

odm_apt_install wireguard-tools iptables

# Without forwarding, a tunnel connects and reaches nothing behind the server.
echo "==> Enabling forwarding"
cat > /etc/sysctl.d/99-odm-vpn.conf <<'SYSCTL'
# Managed by Open Directory Manager.
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
SYSCTL
sysctl -q --system

install -d -m 0700 /etc/wireguard

# Which interface tunnel traffic leaves by. Recorded here so the tunnel
# configuration ODM writes can build its own masquerade rule without asking
# again per tunnel.
if [[ -z "$EXTERNAL_INTERFACE" ]]; then
    # No route to the internet is not a reason to refuse to install; the
    # fallback below covers it. Without || true the failing ip ends the script.
    EXTERNAL_INTERFACE="$(ip -o route get 1.1.1.1 2>/dev/null | awk '{print $5; exit}' || true)"
fi
printf '%s\n' "${EXTERNAL_INTERFACE:-eth0}" > /etc/wireguard/odm-external-interface
chmod 0644 /etc/wireguard/odm-external-interface

cat <<SUMMARY

VPN role installed on $(hostname -f).

  Outbound interface  ${EXTERNAL_INTERFACE:-eth0}
  Configuration       /etc/wireguard (0700)

Create tunnels under Remote Access in the console. Open the port each tunnel
listens on at the perimeter; nothing here does that for you.
SUMMARY
