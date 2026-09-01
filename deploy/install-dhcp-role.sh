#!/usr/bin/env bash
# Install the DHCP role: ISC Kea with a failover pair and dynamic DNS into
# Samba's AD-integrated zones (CLAUDE.md §3.8, §5.4).
#
# Installing the role gives one node a working DHCP server. Pairing two of
# them for failover is configuration, done afterwards under DHCP in the
# console, which re-runs this with --ha-role. ODM talks only to the Control
# Agent; do not hand-edit kea-dhcp4.conf afterwards.

set -euo pipefail

HA_ROLE=""
THIS_URL=""
PEER_URL=""
REALM=""
DNS_SERVER=""
CA_PORT="8000"
CA_USER="odm"

usage() {
    cat >&2 <<'USAGE'
usage: install-dhcp-role.sh --realm CORP.EXAMPLE.INTERNAL --dns-server <dc ip>
                            [--ca-port 8000]
                            [--ha-role primary|standby
                             --this-url http://<this node>:8080/
                             --peer-url http://<other node>:8080/]

  --dns-server             a domain controller running Samba's internal DNS
  --ha-role / --this-url / --peer-url
                           pair this node with another for failover. Omit for
                           a single server; add them later from the console.
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

[[ -n "$REALM" && -n "$DNS_SERVER" ]] || usage
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

# Shared helpers: apt that survives a controller, and a dpkg that recovers.
# shellcheck source=odm-role-common.sh
. "$(dirname "$0")/odm-role-common.sh"


# Failover is all three or none of them.
HA_COUNT=0
for VALUE in "$HA_ROLE" "$THIS_URL" "$PEER_URL"; do
    [[ -n "$VALUE" ]] && HA_COUNT=$((HA_COUNT + 1))
done
if [[ "$HA_COUNT" -ne 0 && "$HA_COUNT" -ne 3 ]]; then
    echo "failover needs --ha-role, --this-url and --peer-url together" >&2
    exit 1
fi
if [[ -n "$HA_ROLE" && "$HA_ROLE" != "primary" && "$HA_ROLE" != "standby" ]]; then
    echo "--ha-role must be primary or standby" >&2
    exit 1
fi

THIS_NAME="$(hostname -s)"
DOMAIN="$(printf '%s' "$REALM" | tr '[:upper:]' '[:lower:]')"

echo "==> Installing Kea"
odm_apt_install kea-dhcp4-server kea-ctrl-agent kea-dhcp-ddns-server \
    kea-common krb5-user

HOOKS_DIR="$(dirname "$(find /usr/lib -name 'libdhcp_ha.so' -print -quit 2>/dev/null || true)")"
[[ -d "$HOOKS_DIR" ]] || { echo "cannot locate the Kea hooks directory" >&2; exit 1; }

GSS_HOOK="$HOOKS_DIR/libddns_gss_tsig.so"
if [[ -f "$GSS_HOOK" ]]; then
    echo "==> GSS-TSIG hook found; dynamic updates will be authenticated"
else
    echo "==> NOTE: $GSS_HOOK is not present."
    echo "    Debian does not package the GSS-TSIG hook, so authenticated"
    echo "    dynamic DNS updates are unavailable from the archive alone."
    echo "    kea-dhcp-ddns is configured without it; Samba's AD zones reject"
    echo "    unauthenticated updates, so DHCP leases will not appear in DNS."
    echo "    Either build the hook from ISC's sources and re-run this script,"
    echo "    or register hosts in DNS another way."
fi

echo "==> Generating the Control Agent credential"
# These live with Kea's own configuration because the Control Agent is what
# reads them, and it runs as _kea. Under /etc/odm they would be behind a
# directory only the control plane may enter.
CA_USER_FILE="/etc/kea/odm-ca.user"
CA_PASSWORD_FILE="/etc/kea/odm-ca.password"
if [[ ! -f "$CA_PASSWORD_FILE" ]]; then
    ( umask 077
      openssl rand -base64 32 | tr -d '\n/+=' | head -c 32 > "$CA_PASSWORD_FILE" )
fi
printf '%s' "$CA_USER" > "$CA_USER_FILE"
chown root:_kea "$CA_USER_FILE" "$CA_PASSWORD_FILE" 2>/dev/null || true
chmod 0640 "$CA_USER_FILE" "$CA_PASSWORD_FILE"

backup() { [[ -f "$1" ]] && cp -a "$1" "$1.pre-odm.$(date +%s)"; return 0; }

# A single server has no failover section at all: an empty peer list is not
# the same thing, and Kea refuses one.
HA_HOOK=""
if [[ -n "$HA_ROLE" ]]; then
    PEER_NAME="$(printf '%s' "$PEER_URL" | sed -E 's#^https?://##; s#[:/].*##')"
    PEER_ROLE=$([[ "$HA_ROLE" == "primary" ]] && echo standby || echo primary)
    HA_HOOK=$(cat <<JSON
,
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
JSON
)
fi

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
      }$HA_HOOK
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
        "user-file": "$CA_USER_FILE",
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
odm_enable kea-dhcp4-server kea-dhcp-ddns-server kea-ctrl-agent

cat <<SUMMARY

DHCP role installed on $THIS_NAME${HA_ROLE:+ ($HA_ROLE of the failover pair)}.

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
