#!/usr/bin/env bash
# Install the ODM policy agent on a domain-joined Debian machine.
#
# The machine must already be joined (it needs /etc/krb5.keytab and a working
# krb5.conf); the domain-join client does this and then calls this script.

set -euo pipefail

API_URL=""
BINARY="./odm-agent"
CLIENT_BINARY=""
CA_CERT=""

usage() {
    cat >&2 <<'USAGE'
usage: install-agent.sh --api-url https://<api fqdn>:8443 [--binary <path>]
                        [--client-binary <path>] [--ca-cert <path>]
USAGE
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --api-url) API_URL="${2:?}"; shift 2 ;;
        --binary) BINARY="${2:?}"; shift 2 ;;
        --client-binary) CLIENT_BINARY="${2:?}"; shift 2 ;;
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

REALM="$(awk -F'=' '/default_realm/ {gsub(/ /,"",$2); print $2}' /etc/krb5.conf 2>/dev/null | head -1 || true)"
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
# Every installer sources this from its own directory; without it they all
# fail on the first line that matters.
install -m 0644 "$(dirname "$0")/odm-role-common.sh" /usr/lib/odm/roles/
# On a controller the agent is also what installs a re-issued console
# certificate, for the same reason: the control plane may not write /etc or
# restart itself.
HELPER="$(dirname "$0")/odm-apply-console-certificate"
[[ -f "$HELPER" ]] && install -m 0755 "$HELPER" /usr/lib/odm/roles/

# The network-boot role hands installed machines something to join the domain
# with, and that something is this binary. Without it the role refuses to
# install, on the one machine an operator is most likely to install it from.
if [[ -z "$CLIENT_BINARY" ]]; then
    for CANDIDATE in "$(dirname "$0")/../client-join/odm-client-install" \
                     "$(dirname "$0")/odm-client-install"; do
        [[ -f "$CANDIDATE" ]] && { CLIENT_BINARY="$CANDIDATE"; break; }
    done
fi
if [[ -n "$CLIENT_BINARY" && -f "$CLIENT_BINARY" ]]; then
    install -m 0755 "$CLIENT_BINARY" /usr/sbin/odm-client-install
fi
# Debian 13 ships systemd-ssh-generator, which runs on every daemon-reload
# and, on a virtual machine with no vsock device, logs
#
#   Failed to query local AF_VSOCK CID: Cannot assign requested address
#
# to the console each time. Installing a role is hundreds of daemon-reloads,
# so the console fills with a message about a feature the machine does not
# have. Masking the generator is the documented way to turn one off; nothing
# here or in Debian uses SSH over vsock.
if [[ ! -e /dev/vsock && -x /usr/lib/systemd/system-generators/systemd-ssh-generator ]]; then
    install -d -m 0755 /etc/systemd/system-generators
    ln -sf /dev/null /etc/systemd/system-generators/systemd-ssh-generator
fi

install -d -m 0750 /etc/odm /var/lib/odm

# On the console's own machine, point at the live certificate rather than a
# copy of it. Replacing the console certificate — which the CA role does, and
# which regenerating the self-signed one does — otherwise leaves every local
# copy stale and the agent stops with "certificate signed by unknown
# authority" until somebody notices.
if [[ -n "$CA_CERT" ]] && [[ "$(readlink -f "$CA_CERT")" == "/etc/odm/tls/api.crt" ]]; then
    CA_PATH="/etc/odm/tls/api.crt"
elif [[ -n "$CA_CERT" ]]; then
    CA_PATH="/etc/odm/tls/api-ca.pem"
fi

if [[ -n "$CA_CERT" ]]; then
    install -d -m 0755 /etc/odm/tls
    [[ "$CA_PATH" == "/etc/odm/tls/api.crt" ]] ||
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
  "ca_cert": "${CA_PATH:-}",
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
