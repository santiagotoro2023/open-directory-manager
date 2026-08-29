#!/usr/bin/env bash
# Install the ODM policy agent on a domain-joined Debian machine.
#
# The machine must already be joined (it needs /etc/krb5.keytab and a working
# krb5.conf); the domain-join client does this and then calls this script.

set -euo pipefail

API_URL=""
BINARY="./odm-agent"
CA_CERT=""

usage() {
    cat >&2 <<'USAGE'
usage: install-agent.sh --api-url https://<api fqdn>:8443 [--binary <path>] [--ca-cert <path>]
USAGE
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --api-url) API_URL="${2:?}"; shift 2 ;;
        --binary) BINARY="${2:?}"; shift 2 ;;
        --ca-cert) CA_CERT="${2:?}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

[[ -n "$API_URL" ]] || usage
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
[[ "$API_URL" == https://* ]] || { echo "--api-url must be https" >&2; exit 1; }
[[ -f /etc/krb5.keytab ]] || { echo "no machine keytab; join the domain first" >&2; exit 1; }
[[ -f "$BINARY" ]] || { echo "agent binary not found: $BINARY" >&2; exit 1; }

REALM="$(awk -F'=' '/default_realm/ {gsub(/ /,"",$2); print $2}' /etc/krb5.conf | head -1)"
[[ -n "$REALM" ]] || { echo "cannot read default_realm from /etc/krb5.conf" >&2; exit 1; }
API_HOST="${API_URL#https://}"
API_HOST="${API_HOST%%:*}"

echo "==> Installing packages the appliers depend on"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends \
    cifs-utils libpam-mount nftables dconf-cli sudo openssh-server

install -m 0755 "$BINARY" /usr/sbin/odm-agent

# Role installers ship with the agent so a member server can be given a role
# from the console. The control plane cannot run a subprocess on a machine it
# is not; the agent runs these when it is asked to.
install -d -m 0755 /usr/lib/odm/roles
for INSTALLER in "$(dirname "$0")"/install-*-role.sh; do
    [[ -f "$INSTALLER" ]] && install -m 0755 "$INSTALLER" /usr/lib/odm/roles/
done
install -d -m 0750 /etc/odm /var/lib/odm

if [[ -n "$CA_CERT" ]]; then
    install -d -m 0755 /etc/odm/tls
    install -m 0644 "$CA_CERT" /etc/odm/tls/api-ca.pem
fi

umask 077
cat > /etc/odm/agent.json <<JSON
{
  "api_url": "$API_URL",
  "service_principal": "HTTP/$API_HOST",
  "keytab": "/etc/krb5.keytab",
  "realm": "$REALM",
  "krb5_conf": "/etc/krb5.conf",
  "ca_cert": "$([[ -n "$CA_CERT" ]] && echo /etc/odm/tls/api-ca.pem)",
  "refresh_minutes": 15
}
JSON
chmod 0640 /etc/odm/agent.json

install -m 0644 "$(dirname "$0")/odm-agent.service" /etc/systemd/system/odm-agent.service
systemctl daemon-reload
systemctl enable --now odm-agent

cat <<SUMMARY

Policy agent installed.

  Binary   /usr/sbin/odm-agent
  Config   /etc/odm/agent.json
  Realm    $REALM
  API      $API_URL

Apply immediately with:  odm-agent apply --force
SUMMARY
