#!/usr/bin/env bash
# Install the monitoring role: the node that probes the network.
#
# The measuring itself needs nothing installed — every agent reads its own
# machine and reports once the role exists anywhere in the domain, and the
# control plane keeps the numbers, evaluates the rules and tells whoever is
# listening. What a monitoring node adds is a vantage point: it is the
# machine that pings the switches, opens the printers' ports and fetches the
# web pages that have no agent of their own, on the schedule the console
# gives it. So this installs the two tools those probes use and nothing
# else.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

# Shared helpers: apt that survives a controller, and a dpkg that recovers.
# shellcheck source=odm-role-common.sh
. "$(dirname "$0")/odm-role-common.sh"

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) echo "usage: install-monitoring-role.sh" >&2; exit 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

odm_apt_install iputils-ping curl

# The agent reads this to know it is a probing node; the console's policy
# document says the same, and the file is what survives a console that is
# briefly unreachable.
install -d -m 0755 /etc/odm
printf '# Managed by Open Directory Manager. This machine runs monitoring probes.\n' \
    > /etc/odm/monitoring-role

cat <<SUMMARY

Monitoring role installed on $(hostname -f).

  Probes         run from here, as defined under Monitoring → Probes
  Metrics        every agent reports its own machine's from now on
  Dashboards     Monitoring, in the console

Nothing listens on a new port.
SUMMARY
