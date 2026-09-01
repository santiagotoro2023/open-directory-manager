#!/usr/bin/env bash
# Install the RADIUS role: FreeRADIUS authenticating against the domain.
#
# The role is the server. Which devices may ask, and who may authenticate
# where, are configured under Network Access in the console — so a switch or
# an access point can be added without reinstalling anything.
#
# Two ways in, both against the same directory:
#   PAP / MSCHAPv2  through winbind, which is already joined to the domain
#   EAP-TLS         with certificates from the ODM certificate authority

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

# Shared helpers: apt that survives a controller, and a dpkg that recovers.
# shellcheck source=odm-role-common.sh
. "$(dirname "$0")/odm-role-common.sh"


odm_apt_install freeradius freeradius-utils winbind krb5-user

CONF="/etc/freeradius/3.0"
[[ -d "$CONF" ]] || { echo "freeradius 3.0 configuration not found at $CONF" >&2; exit 1; }

backup() { [[ -f "$1" ]] && cp -a "$1" "$1.pre-odm.$(date +%s)"; return 0; }

echo "==> Letting FreeRADIUS ask winbind"
# ntlm_auth is how a domain password is checked without FreeRADIUS ever seeing
# it. The daemon runs as freerad, so it needs to reach winbind's socket.
install -d -m 0750 -o root -g winbindd_priv /var/lib/samba/winbindd_privileged 2>/dev/null || true
if getent group winbindd_priv >/dev/null; then
    adduser freerad winbindd_priv >/dev/null 2>&1 || true
fi

echo "==> Writing the ODM configuration"
install -d -m 0750 -o freerad -g freerad "$CONF/odm"
# Clients and policies are rendered here by the agent, from what the console
# holds. Everything else in the FreeRADIUS configuration is left alone.
for FILE in clients.conf policy.conf; do
    [[ -f "$CONF/odm/$FILE" ]] || {
        printf '# Managed by Open Directory Manager. Written by the ODM agent.\n' \
            > "$CONF/odm/$FILE"
        chown freerad:freerad "$CONF/odm/$FILE"
        chmod 0640 "$CONF/odm/$FILE"
    }
done

backup "$CONF/clients.conf"
if ! grep -q 'odm/clients.conf' "$CONF/clients.conf"; then
    printf '\n# Managed by Open Directory Manager\n$INCLUDE odm/clients.conf\n' \
        >> "$CONF/clients.conf"
fi

echo "==> Starting FreeRADIUS"
odm_enable freeradius

cat <<SUMMARY

RADIUS role installed on $(hostname -f).

  Configuration  $CONF/odm (written by the ODM agent)
  Listening      1812/udp authentication, 1813/udp accounting

Add the devices that ask, and the rules that decide, under Network Access.
Open those ports to your switches, access points or VPN server; nothing here
does that for you.
SUMMARY
