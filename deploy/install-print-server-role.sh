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


odm_apt_install cups cups-ipp-utils cups-filters printer-driver-all avahi-daemon

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

for directive, value in (("Browsing", "On"), ("BrowseLocalProtocols", "dnssd")):
    if re.search(rf"^{directive}\s+", body, re.M):
        body = re.sub(rf"^{directive}\s+.*$", f"{directive} {value}", body, flags=re.M)
    else:
        body += f"\n{directive} {value}\n"

path.write_text(body)
PYTHON

# Allow printing and browsing from anywhere on the network; keep the
# administrative locations as the package shipped them.
install -d -m 0755 /etc/cups/cupsd.conf.d
cat > /etc/cups/cupsd.conf.d/odm-access.conf <<'ACCESS'
# Managed by Open Directory Manager.
<Location />
  Order allow,deny
  Allow all
</Location>
ACCESS

echo "==> Starting CUPS"
odm_enable cups

cat <<SUMMARY

Print-server role installed on $(hostname -f).

Add printers under Printers in the console. A policy object then hands them to
users or groups; clients need no driver installed of their own.
SUMMARY
