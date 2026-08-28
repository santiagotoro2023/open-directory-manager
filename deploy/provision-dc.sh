#!/usr/bin/env bash
# Provision the first Samba Active Directory domain controller for ODM.
#
# Samba does the work (CLAUDE.md §5.1) — this script only automates the
# surrounding steps that are easy to get wrong: disabling the conflicting
# standalone daemons, keeping Kerberos config in one place, and pointing the
# host's resolver at its own DNS.
#
# Run on a freshly installed Debian 12 (bookworm) or 13 (trixie) server with
# a static address and the final hostname already set. It is destructive to
# any existing Samba configuration; it refuses to touch an already-provisioned
# host.
#
#   ODM_ADMIN_PASSWORD='...' ./provision-dc.sh \
#       --realm corp.example.internal --netbios EXAMPLE --forwarder 9.9.9.9
#
# The domain Administrator password is read from ODM_ADMIN_PASSWORD, or
# prompted for. It is never passed as an argument (arguments are world
# readable in /proc).

set -euo pipefail

REALM=""
NETBIOS=""
FORWARDER=""
DNS_BACKEND="SAMBA_INTERNAL"

usage() {
    cat >&2 <<'EOF'
usage: provision-dc.sh --realm <dns.domain> --netbios <SHORTNAME> [--forwarder <ip>]

  --realm      DNS domain for the forest root, e.g. corp.example.internal
  --netbios    NetBIOS domain name, e.g. EXAMPLE (<= 15 chars, upper case)
  --forwarder  Upstream resolver for non-domain queries (optional)
EOF
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --realm) REALM="${2:?}"; shift 2 ;;
        --netbios) NETBIOS="${2:?}"; shift 2 ;;
        --forwarder) FORWARDER="${2:?}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

[[ -n "$REALM" && -n "$NETBIOS" ]] || usage
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
[[ "$NETBIOS" =~ ^[A-Z0-9-]{1,15}$ ]] || { echo "invalid --netbios" >&2; exit 1; }
[[ "$REALM" =~ ^[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$ ]] || { echo "invalid --realm" >&2; exit 1; }

REALM_UPPER="${REALM^^}"
HOSTNAME_FQDN="$(hostname -f 2>/dev/null || hostname)"

if [[ -f /var/lib/samba/private/sam.ldb ]]; then
    echo "this host is already provisioned as a domain controller; refusing" >&2
    exit 1
fi
if [[ "$HOSTNAME_FQDN" != *.* ]]; then
    echo "set a fully-qualified hostname before provisioning (currently: $HOSTNAME_FQDN)" >&2
    exit 1
fi

if [[ -z "${ODM_ADMIN_PASSWORD:-}" ]]; then
    read -rsp "Domain Administrator password: " ODM_ADMIN_PASSWORD; echo
    read -rsp "Repeat: " ADMIN_PASSWORD_CONFIRM; echo
    [[ "$ODM_ADMIN_PASSWORD" == "$ADMIN_PASSWORD_CONFIRM" ]] || { echo "passwords differ" >&2; exit 1; }
fi

echo "==> Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
    samba smbclient krb5-user krb5-config winbind libnss-winbind libpam-winbind \
    ldb-tools dnsutils chrony acl attr

echo "==> Disabling the standalone file-server daemons"
# A DC runs everything from the single samba-ad-dc unit.
systemctl disable --now smbd nmbd winbind 2>/dev/null || true
systemctl unmask samba-ad-dc
mv /etc/samba/smb.conf "/etc/samba/smb.conf.pre-odm.$(date +%s)" 2>/dev/null || true

echo "==> Provisioning the domain"
samba-tool domain provision \
    --server-role=dc \
    --use-rfc2307 \
    --dns-backend="$DNS_BACKEND" \
    --realm="$REALM_UPPER" \
    --domain="$NETBIOS" \
    --adminpass="$ODM_ADMIN_PASSWORD" \
    --option="ad dc functional level = 2016"

echo "==> Installing Kerberos configuration"
install -m 0644 /var/lib/samba/private/krb5.conf /etc/krb5.conf

if [[ -n "$FORWARDER" ]]; then
    echo "==> Setting DNS forwarder to $FORWARDER"
    sed -i "/^\[global\]/a\\        dns forwarder = $FORWARDER" /etc/samba/smb.conf
fi

echo "==> Pointing the resolver at this DC"
# systemd-resolved's stub listener conflicts with Samba's internal DNS.
if systemctl is-enabled --quiet systemd-resolved 2>/dev/null; then
    systemctl disable --now systemd-resolved
    rm -f /etc/resolv.conf
fi
cat > /etc/resolv.conf <<EOF
search $REALM
nameserver 127.0.0.1
EOF

echo "==> Starting samba-ad-dc"
systemctl enable --now samba-ad-dc

echo "==> Verifying"
sleep 3
samba-tool domain level show
host -t SRV "_ldap._tcp.${REALM}." 127.0.0.1
smbclient -L localhost -N >/dev/null && echo "SMB responding"

cat <<EOF

Domain controller ready.

  Realm            $REALM_UPPER
  NetBIOS domain   $NETBIOS
  DC hostname      $HOSTNAME_FQDN
  LDAPS CA cert    /var/lib/samba/private/tls/ca.pem

Next:
  1. deploy/create-api-service-account.sh --realm $REALM --api-host <api fqdn>
  2. deploy/setup-db.sh
  3. install the ODM API and enable deploy/odm-api.service

Point ODM_LDAP_CA_CERT at the CA above (or replace Samba's self-signed TLS
material under /var/lib/samba/private/tls with certificates from your own CA
before going to production).
EOF
