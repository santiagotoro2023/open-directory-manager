#!/usr/bin/env bash
# Install the DHCP role: ISC Kea with a failover pair and dynamic DNS into
# Samba's AD-integrated zones (CLAUDE.md §3.8, §5.4).
#
# Run this on each of the two DHCP nodes, once with --ha-role primary and
# once with --ha-role standby. ODM talks only to the Control Agent; do not
# hand-edit kea-dhcp4.conf afterwards.

set -euo pipefail

HA_ROLE=""
THIS_URL=""
PEER_URL=""
REALM=""
DNS_SERVER=""
CA_PORT="8000"
CA_USER="odm"
SECRETS_DIR="/etc/odm"

usage() {
    cat >&2 <<'USAGE'
usage: install-dhcp-role.sh --ha-role primary|standby \
                            --this-url http://<this node>:8080/ \
                            --peer-url http://<other node>:8080/ \
                            --realm CORP.EXAMPLE.INTERNAL \
                            --dns-server <dc ip> [--ca-port 8000]

  --this-url / --peer-url  the HA (not Control Agent) endpoints of the pair
  --dns-server             a domain controller running Samba's internal DNS
USAGE
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ha-role) HA_ROLE="${2:?}"; shift 2 ;;
        --this-url) THIS_URL="${2:?}"; shift 2 ;;
        --peer-url) PEER_URL="${2:?}"; shift 2 ;;
        --realm) REALM="${2:?}"; shift 2 ;;
        --dns-server) DNS_SERVER="${2:?}"; shift 2 ;;
        --ca-port) CA_PORT="${2:?}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

[[ -n "$HA_ROLE" && -n "$THIS_URL" && -n "$PEER_URL" && -n "$REALM" && -n "$DNS_SERVER" ]] || usage
[[ "$HA_ROLE" == "primary" || "$HA_ROLE" == "standby" ]] || { echo "--ha-role must be primary or standby" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

THIS_NAME="$(hostname -s)"
PEER_NAME="$(printf '%s' "$PEER_URL" | sed -E 's#^https?://##; s#[:/].*##')"
PEER_ROLE=$([[ "$HA_ROLE" == "primary" ]] && echo standby || echo primary)
DOMAIN="$(printf '%s' "$REALM" | tr '[:upper:]' '[:lower:]')"

echo "==> Installing Kea"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
    kea-dhcp4-server kea-ctrl-agent kea-dhcp-ddns-server kea-common krb5-user

HOOKS_DIR="$(dirname "$(find /usr/lib -name 'libdhcp_ha.so' -print -quit 2>/dev/null || true)")"
[[ -d "$HOOKS_DIR" ]] || { echo "cannot locate the Kea hooks directory" >&2; exit 1; }

GSS_HOOK="$HOOKS_DIR/libddns_gss_tsig.so"
if [[ -f "$GSS_HOOK" ]]; then
    echo "==> GSS-TSIG hook found; dynamic updates will be authenticated"
else
    echo "==> WARNING: $GSS_HOOK is missing." >&2
    echo "    kea-dhcp-ddns will be configured without GSS-TSIG, and Samba will" >&2
    echo "    reject its updates until the hook is installed and this script" >&2
    echo "    is re-run. Secure dynamic update is required for production." >&2
fi

echo "==> Generating the Control Agent credential"
install -d -m 0750 "$SECRETS_DIR"
CA_PASSWORD_FILE="$SECRETS_DIR/kea-ca.password"
if [[ ! -f "$CA_PASSWORD_FILE" ]]; then
    umask 077
    openssl rand -base64 32 | tr -d '\n/+=' | head -c 32 > "$CA_PASSWORD_FILE"
fi
chmod 0640 "$CA_PASSWORD_FILE"
printf '%s' "$CA_USER" > "$SECRETS_DIR/kea-ca.user"
chmod 0640 "$SECRETS_DIR/kea-ca.user"

backup() { [[ -f "$1" ]] && cp -a "$1" "$1.pre-odm.$(date +%s)"; return 0; }

echo "==> Writing /etc/kea/kea-dhcp4.conf"
backup /etc/kea/kea-dhcp4.conf
cat > /etc/kea/kea-dhcp4.conf <<JSON
// Managed by Open Directory Manager. Change scopes through the ODM UI or
// API, never by editing this file: ODM rewrites it through config-set.
{
  "Dhcp4": {
    "interfaces-config": { "interfaces": [ "*" ] },
    "control-socket": {
      "socket-type": "unix",
      "socket-name": "/run/kea/kea4-ctrl-socket"
    },
    "lease-database": {
      "type": "memfile",
      "lfc-interval": 3600,
      "name": "/var/lib/kea/kea-leases4.csv"
    },
    "valid-lifetime": 3600,
    "renew-timer": 900,
    "rebind-timer": 1800,

    "dhcp-ddns": {
      "enable-updates": true,
      "server-ip": "127.0.0.1",
      "server-port": 53001
    },
    "ddns-send-updates": true,
    "ddns-qualifying-suffix": "$DOMAIN",
    "ddns-override-client-update": true,
    "ddns-replace-client-name": "when-not-present",

    "hooks-libraries": [
      {
        "library": "$HOOKS_DIR/libdhcp_lease_cmds.so"
      },
      {
        "library": "$HOOKS_DIR/libdhcp_ha.so",
        "parameters": {
          "high-availability": [ {
            "this-server-name": "$THIS_NAME",
            "mode": "hot-standby",
            "heartbeat-delay": 10000,
            "max-response-delay": 60000,
            "max-ack-delay": 5000,
            "max-unacked-clients": 5,
            "peers": [
              {
                "name": "$THIS_NAME",
                "url": "$THIS_URL",
                "role": "$HA_ROLE",
                "auto-failover": true
              },
              {
                "name": "$PEER_NAME",
                "url": "$PEER_URL",
                "role": "$PEER_ROLE",
                "auto-failover": true
              }
            ]
          } ]
        }
      }
    ],

    "subnet4": [],

    "loggers": [ {
      "name": "kea-dhcp4",
      "output_options": [ { "output": "syslog" } ],
      "severity": "INFO"
    } ]
  }
}
JSON

echo "==> Writing /etc/kea/kea-dhcp-ddns.conf"
backup /etc/kea/kea-dhcp-ddns.conf
if [[ -f "$GSS_HOOK" ]]; then
    GSS_BLOCK=$(cat <<JSON
    "hooks-libraries": [ {
      "library": "$GSS_HOOK",
      "parameters": {
        "server-principal": "DNS/$DNS_SERVER@$REALM",
        "client-keytab": "FILE:/etc/odm/kea-ddns.keytab",
        "credentials-cache": "FILE:/var/lib/kea/ddns.ccache",
        "tkey-lifetime": 3600,
        "servers": [ {
          "id": "samba-dns",
          "ip-address": "$DNS_SERVER",
          "port": 53
        } ]
      }
    } ],
JSON
)
else
    GSS_BLOCK=""
fi

cat > /etc/kea/kea-dhcp-ddns.conf <<JSON
// Managed by Open Directory Manager.
// DHCP leases are pushed into Samba's AD-integrated DNS from here, so a
// DHCP-assigned host resolves without anyone touching DNS by hand.
{
  "DhcpDdns": {
    "ip-address": "127.0.0.1",
    "port": 53001,
$GSS_BLOCK
    "forward-ddns": {
      "ddns-domains": [ {
        "name": "$DOMAIN.",
        "dns-servers": [ { "ip-address": "$DNS_SERVER" } ]
      } ]
    },
    "reverse-ddns": {
      "ddns-domains": [ {
        "name": "in-addr.arpa.",
        "dns-servers": [ { "ip-address": "$DNS_SERVER" } ]
      } ]
    },
    "loggers": [ {
      "name": "kea-dhcp-ddns",
      "output_options": [ { "output": "syslog" } ],
      "severity": "INFO"
    } ]
  }
}
JSON

echo "==> Writing /etc/kea/kea-ctrl-agent.conf"
backup /etc/kea/kea-ctrl-agent.conf
cat > /etc/kea/kea-ctrl-agent.conf <<JSON
// Managed by Open Directory Manager. Bound to the loopback: ODM is the only
// client, and the credential below is the second factor if that changes.
{
  "Control-agent": {
    "http-host": "127.0.0.1",
    "http-port": $CA_PORT,
    "authentication": {
      "type": "basic",
      "realm": "kea-control-agent",
      "clients": [ {
        "user-file": "$SECRETS_DIR/kea-ca.user",
        "password-file": "$CA_PASSWORD_FILE"
      } ]
    },
    "control-sockets": {
      "dhcp4": {
        "socket-type": "unix",
        "socket-name": "/run/kea/kea4-ctrl-socket"
      },
      "d2": {
        "socket-type": "unix",
        "socket-name": "/run/kea/kea-ddns-ctrl-socket"
      }
    },
    "loggers": [ {
      "name": "kea-ctrl-agent",
      "output_options": [ { "output": "syslog" } ],
      "severity": "INFO"
    } ]
  }
}
JSON
chmod 0640 /etc/kea/kea-*.conf
chgrp _kea /etc/kea/kea-*.conf 2>/dev/null || true

echo "==> Starting services"
systemctl enable --now kea-dhcp4-server kea-dhcp-ddns-server kea-ctrl-agent
sleep 2
systemctl is-active --quiet kea-ctrl-agent || { echo "kea-ctrl-agent did not start" >&2; exit 1; }

cat <<SUMMARY

DHCP role installed on $THIS_NAME ($HA_ROLE of the failover pair).

Add to the ODM secrets file on the API host:

  ODM_KEA_URL=http://127.0.0.1:$CA_PORT/
  ODM_KEA_USER=$CA_USER
  ODM_KEA_PASSWORD=$(cat "$CA_PASSWORD_FILE")

Then register the role in the UI under Server Roles. Scopes, pools,
reservations and options are managed from ODM only.

For secure dynamic DNS updates, export a keytab for the DDNS client on a
domain controller and copy it to /etc/odm/kea-ddns.keytab (mode 0640):

  samba-tool user create svc-kea-ddns --random-password
  samba-tool spn add DHCP/\$(hostname -f) svc-kea-ddns
  samba-tool domain exportkeytab /etc/odm/kea-ddns.keytab --principal=DHCP/\$(hostname -f)
SUMMARY
