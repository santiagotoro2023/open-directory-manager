#!/usr/bin/env bash
# Install the print-server role: CUPS, shared to the domain.
#
# The role is the server. The printers themselves are created and edited under
# Printers in the console, which is what lets one server carry several and lets
# their settings change without reinstalling anything.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

# Shared helpers: apt that survives a controller, and a dpkg that recovers.
# shellcheck source=odm-role-common.sh
. "$(dirname "$0")/odm-role-common.sh"


# python3 edits cupsd.conf below. It is on a domain controller already and
# not necessarily on a member server, and the role installs onto either.
odm_apt_install cups cups-ipp-utils cups-filters avahi-daemon avahi-utils python3 \
    printer-driver-gutenprint printer-driver-postscript-hp

backup() { [[ -f "$1" ]] && cp -a "$1" "$1.pre-odm.$(date +%s)"; return 0; }

echo "==> Sharing printers on the network"
backup /etc/cups/cupsd.conf
# Listen on the network, and let the domain browse and print. Administration
# stays local: printers are managed through ODM, not through CUPS' own web UI
# from another machine.
python3 - <<'PYTHON'
import re
from pathlib import Path

path = Path("/etc/cups/cupsd.conf")
body = path.read_text()

managed = "# Managed by Open Directory Manager.\n"
if managed not in body:
    body = managed + body

# Bind to every interface rather than localhost alone.
if not re.search(r"^Listen\s+\*:631", body, re.M):
    body = re.sub(r"^Listen\s+localhost:631.*$", "Listen *:631", body, flags=re.M)
    if "Listen *:631" not in body:
        body += "\nListen *:631\n"

# Browsing on so the queues are shareable, but nothing is advertised over
# DNS-SD: ODM hands printers to clients by policy, and a queue advertised as
# well appears a second time on every desktop under a name nobody chose
# ("Brother_DCP_L3560CDW_print01"), beside the one the policy created.
for directive, value in (("Browsing", "On"), ("BrowseLocalProtocols", "none")):
    if re.search(rf"^{directive}\s+", body, re.M):
        body = re.sub(rf"^{directive}\s+.*$", f"{directive} {value}", body, flags=re.M)
    else:
        body += f"\n{directive} {value}\n"

# Let the network reach the queues. cupsd.conf has no include mechanism, so
# this has to be the file itself: a drop-in under cupsd.conf.d was written and
# never read, <Location /> kept its shipped "Order allow,deny" with nothing
# allowed, and every client got an authentication prompt it could not satisfy
# when it tried to print.
#
# @LOCAL is CUPS' own token for a directly-connected network. Administration
# stays where the package left it: printers are managed through ODM, not
# through CUPS' web interface from another machine.
if re.search(r"^<Location />", body, re.M):
    body = re.sub(
        r"^<Location />.*?^</Location>",
        "<Location />\n  Order allow,deny\n  Allow @LOCAL\n</Location>",
        body,
        flags=re.M | re.S,
    )
else:
    body += "\n<Location />\n  Order allow,deny\n  Allow @LOCAL\n</Location>\n"

path.write_text(body)
PYTHON

rm -f /etc/cups/cupsd.conf.d/odm-access.conf

# A print server is the machine that goes looking for printers, and looking is
# an avahi browse. Managed machines turn avahi off so a printer advertising
# itself does not appear beside the ones the domain gave them; this says not
# here.
install -d -m 0755 /etc/odm
cat > /etc/odm/print-server <<'MARKER'
# Managed by Open Directory Manager.
# This machine scans the network for printers, so it keeps avahi.
MARKER

echo "==> Starting CUPS"
odm_enable cups

cat <<SUMMARY

Print-server role installed on $(hostname -f).

Add printers under Printers in the console. A policy object then hands them to
users or groups; clients need no driver installed of their own.
SUMMARY
