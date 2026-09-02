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


# freeradius-config's postinst generates Diffie-Hellman parameters if the
# file is not already there, and "Generating DH parameters, 1024 bit long safe
# prime" is minutes of CPU on a virtual machine with the install apparently
# hung. This is RFC 3526 group 14, the published 2048-bit MODP group — a
# standard constant, not a key and not something invented here — so there is
# nothing to generate and the group is stronger than the one it replaces.
install -d -m 0755 /etc/freeradius /etc/freeradius/3.0 /etc/freeradius/3.0/certs
if [[ ! -s /etc/freeradius/3.0/certs/dh ]]; then
    cat > /etc/freeradius/3.0/certs/dh <<'DHPARAM'
-----BEGIN DH PARAMETERS-----
MIIBCAKCAQEA///////////JD9qiIWjCNMTGYouA3BzRKQJOCIpnzHQCC76mOxOb
IlFKCHmONATd75UZs806QxswKwpt8l8UN0/hNW1tUcJF5IW1dmJefsb0TELppjft
awv/XLb0Brft7jhr+1qJn6WunyQRfEsf5kkoZlHs5Fs9wgB8uKFjvwWY2kg2HFXT
mmkWP6j9JM9fg2VdI9yjrZYcYvNWIIVSu57VKQdwlpZtZww1Tkq8mATxdGwIyhgh
fDKQXkYuNs474553LBgOhgObJ4Oi7Aeij7XFXfBvTFLJ3ivL9pVYFxg5lUl86pVq
5RXSJhiY+gUQFXKOWoqsqmj//////////wIBAg==
-----END DH PARAMETERS-----
DHPARAM
fi

odm_apt_install freeradius freeradius-utils winbind krb5-user

# The package owns this directory; give the file back to it.
chown freerad:freerad /etc/freeradius/3.0/certs/dh 2>/dev/null || true
chmod 0640 /etc/freeradius/3.0/certs/dh

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

echo "==> Giving FreeRADIUS a server certificate of its own"
# EAP needs a key, and Debian's default configuration points every service on
# the machine at the same snakeoil pair. Sharing it does not work here: the
# remote desktop role's xrdp takes that key for its own group, and FreeRADIUS —
# whatever group it is in — then gets
#
#   tls: (TLS) Failed reading private key file "/etc/ssl/private/ssl-cert-snakeoil.key"
#   tls: (TLS) error:8000000D:system library::Permission denied
#
# and refuses to start at all, which reads as the whole role failing rather
# than as two roles wanting one file. So it gets its own pair, which nothing
# else touches. Replace it with one from the certificate authority when the
# supplicants on the network should verify it.
RADIUS_TLS="$CONF/odm/tls"
install -d -m 0750 -o freerad -g freerad "$RADIUS_TLS"
if [[ ! -s "$RADIUS_TLS/server.key" ]]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$RADIUS_TLS/server.key" -out "$RADIUS_TLS/server.pem" \
        -subj "/CN=$(hostname -f)" >/dev/null 2>&1
fi
chown freerad:freerad "$RADIUS_TLS/server.key" "$RADIUS_TLS/server.pem"
chmod 0640 "$RADIUS_TLS/server.key"
chmod 0644 "$RADIUS_TLS/server.pem"
backup "$CONF/mods-available/eap"
sed -i -E \
    -e "s#^([[:space:]]*)private_key_file[[:space:]]*=.*#\1private_key_file = $RADIUS_TLS/server.key#" \
    -e "s#^([[:space:]]*)certificate_file[[:space:]]*=.*#\1certificate_file = $RADIUS_TLS/server.pem#" \
    "$CONF/mods-available/eap"

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
