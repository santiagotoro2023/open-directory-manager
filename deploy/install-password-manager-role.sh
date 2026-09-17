#!/usr/bin/env bash
# Install the password-manager role: Vaultwarden, the open-source Bitwarden
# server, run as a container under systemd, with its vault on this machine.
#
# Vaultwarden is not packaged by Debian, and building it needs a Rust
# toolchain no server should carry; the project's own container image is
# how it is meant to be run. podman runs it without a daemon, as a systemd
# service (a quadlet), restarted with the machine. The vault's data — the
# encrypted vaults themselves, which the server cannot read — lives under
# /var/lib/odm/vaultwarden. Sign-ups are closed: people get in by being
# invited, which is what the directory sync does.
#
# TLS: a self-signed certificate to start, so the service comes up; the
# console replaces it with one from the domain's certificate authority when
# it applies the role's configuration (passwords-apply), and every domain
# member trusts that authority already.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

# shellcheck source=odm-role-common.sh
. "$(dirname "$0")/odm-role-common.sh"

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) echo "usage: install-password-manager-role.sh" >&2; exit 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

CONF=/etc/odm/vaultwarden
DATA=/var/lib/odm/vaultwarden
FQDN=$(hostname -f)

odm_apt_install podman unzip curl openssl

install -d -m 0750 "$CONF" "$CONF/tls"
install -d -m 0700 "$DATA"

# The admin page's token, made once. Written root-only here and reported to
# the console at the end, which is the one time it is shown in clear.
if [[ ! -s "$CONF/admin-token" ]]; then
    openssl rand -base64 36 | tr -d '\n' > "$CONF/admin-token"
    chmod 0600 "$CONF/admin-token"
fi
ADMIN_TOKEN=$(cat "$CONF/admin-token")

if [[ ! -s "$CONF/tls/server.key" ]]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -subj "/CN=$FQDN" -addext "subjectAltName=DNS:$FQDN" \
        -keyout "$CONF/tls/server.key" -out "$CONF/tls/server.pem" 2>/dev/null
fi
chmod 0644 "$CONF/tls/server.pem"
chmod 0640 "$CONF/tls/server.key"

# What the service reads. The console rewrites DOMAIN and the SMTP lines when
# it applies configuration; the token and the TLS paths stay.
if [[ ! -s "$CONF/env" ]]; then
    cat > "$CONF/env" <<ENV
# Managed by Open Directory Manager. Local edits are overwritten.
DOMAIN=https://$FQDN
SIGNUPS_ALLOWED=false
INVITATIONS_ALLOWED=true
ORG_GROUPS_ENABLED=true
SHOW_PASSWORD_HINT=false
ADMIN_TOKEN=$ADMIN_TOKEN
ROCKET_TLS={certs="/tls/server.pem",key="/tls/server.key"}
ROCKET_PORT=443
ENV
    chmod 0600 "$CONF/env"
fi

# The quadlet: podman's own way of running a container as a unit. Pulled on
# first start; updated by pulling again and restarting.
install -d -m 0755 /etc/containers/systemd
cat > /etc/containers/systemd/vaultwarden.container <<UNIT
# Managed by Open Directory Manager. Local edits are overwritten.
[Unit]
Description=Vaultwarden password manager (Open Directory Manager role)
After=network-online.target
Wants=network-online.target

[Container]
Image=docker.io/vaultwarden/server:latest
ContainerName=vaultwarden
EnvironmentFile=$CONF/env
Volume=$DATA:/data:Z
Volume=$CONF/tls:/tls:ro,Z
# The machine's own trust bundle, so the vault can reach the console — the
# domain's OpenID provider — whose certificate the domain authority issued.
Volume=/etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro
PublishPort=443:443
AutoUpdate=registry

[Service]
Restart=always
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target default.target
UNIT

systemctl daemon-reload
systemctl start vaultwarden.service || {
    echo "vaultwarden did not start; podman's own message follows" >&2
    journalctl -u vaultwarden.service -n 20 --no-pager >&2 || true
    exit 1
}
# Pull image updates weekly, the way podman documents it.
systemctl enable --now podman-auto-update.timer >/dev/null 2>&1 || true

cat <<SUMMARY

Password-manager role installed on $FQDN.

  Vault           https://$FQDN
  Admin page      https://$FQDN/admin   token: $ADMIN_TOKEN
  Data            $DATA (the vaults, encrypted end to end)

The certificate is self-signed until the console applies the role's
configuration; sign-ups are closed, and the directory sync invites people.
Next: Passwords in the console — create the organisation in the vault, paste
its API key, and choose the groups whose members get a seat.
SUMMARY
