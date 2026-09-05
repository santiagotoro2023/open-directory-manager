#!/usr/bin/env bash
# Install the time role: chrony, serving the domain.
#
# Kerberos refuses a ticket whose timestamp is more than five minutes off, so
# a machine with a drifting clock stops being able to sign in, mount a share
# or apply policy — and says none of that in a way anybody reads as a clock
# problem. A domain controller is already the time source for the machines
# joined to it; this makes that deliberate, and makes the drift visible.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

# Shared helpers: apt that survives a controller, and a dpkg that recovers.
# shellcheck source=odm-role-common.sh
. "$(dirname "$0")/odm-role-common.sh"

UPSTREAM=""
ALLOW=""

usage() {
    cat >&2 <<'USAGE'
usage: install-time-role.sh [--upstream "<servers>"] [--allow "<networks>"]

  --upstream  where this machine gets the time, space separated. Empty uses
              Debian's own pool.
  --allow     networks that may ask it for the time, in CIDR, space
              separated. Empty serves the networks this machine is on.
USAGE
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --upstream) UPSTREAM="${2:?}"; shift 2 ;;
        --allow) ALLOW="${2:?}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

odm_apt_install chrony

# Where this machine gets the time from, and who may ask it for the time.
# Debian's own pool unless the operator named something else: an estate behind
# a firewall usually has an appliance or an upstream of its own.
if [[ -z "$UPSTREAM" ]]; then
    UPSTREAM="0.debian.pool.ntp.org 1.debian.pool.ntp.org 2.debian.pool.ntp.org"
fi

# The networks that may ask. Left empty, every network the machine is on,
# which is what a domain controller serving its own clients needs.
if [[ -z "$ALLOW" ]]; then
    ALLOW="$(hostname -I 2>/dev/null | tr ' ' '\n' | awk 'NF' | while read -r address; do
        printf '%s/24\n' "${address%.*}.0"
    done | sort -u | tr '\n' ' ')"
fi

install -d -m 0755 /etc/chrony/conf.d
{
    echo "# Managed by Open Directory Manager. Local edits are overwritten."
    echo "#"
    echo "# Kerberos gives up on a clock more than five minutes out, so the"
    echo "# whole domain depends on this being right."
    for source in $UPSTREAM; do
        # iburst: four packets at first contact rather than one a minute, so a
        # machine that has just booted is in step in seconds rather than in
        # five minutes of failed sign-ins.
        echo "pool $source iburst"
    done
    for network in $ALLOW; do
        echo "allow $network"
    done
    # Serve the time even before this machine has settled on it itself, at a
    # stratum that says so. Without it a controller that has just restarted
    # refuses every client until it has synchronised, which is exactly when
    # its clients are asking.
    echo "local stratum 10"
    # Step rather than slew a clock that is badly wrong, but only in the first
    # few updates after start: a running machine whose clock jumps breaks
    # anything measuring an interval.
    echo "makestep 1.0 3"
    echo "rtcsync"
} > /etc/chrony/conf.d/odm-time.conf
chmod 0644 /etc/chrony/conf.d/odm-time.conf

# Debian's default configuration has its own pool line. Left alone: chrony
# reads both, and removing a distribution's configuration file to add our own
# is how an upgrade puts it back and nobody notices.

odm_enable chrony

# Marks the machine as carrying the role, the way every other role does.
install -d -m 0755 /etc/odm
: > /etc/odm/time-server

cat <<SUMMARY

Time role installed.

  Serving     123/udp
  Upstream    $UPSTREAM
  Answering   ${ALLOW:-nothing yet}

  chronyc sources     where this machine gets the time
  chronyc clients     who is asking it for the time

Point clients at this machine with a DHCP option, or leave them to find their
domain controller, which is what a domain-joined machine does by default.
SUMMARY
