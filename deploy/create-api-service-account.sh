#!/usr/bin/env bash
# Create the least-privilege service account the ODM API authenticates as.
#
# The API never binds as a Domain Admin for routine reads (CLAUDE.md §6): it
# uses this account's keytab both to accept SPNEGO tickets from browsers and
# agents (HTTP/<api fqdn>) and to make read-only GSSAPI LDAP binds. The
# account is a member of Domain Users and nothing else.
#
# Run on a provisioned domain controller.

set -euo pipefail

REALM=""
API_HOST=""
ACCOUNT="svc-odm-api"
KEYTAB="/etc/odm/odm-api.keytab"

usage() {
    cat >&2 <<'EOF'
usage: create-api-service-account.sh --realm <dns.domain> --api-host <fqdn> [--keytab <path>]
EOF
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --realm) REALM="${2:?}"; shift 2 ;;
        --api-host) API_HOST="${2:?}"; shift 2 ;;
        --keytab) KEYTAB="${2:?}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

[[ -n "$REALM" && -n "$API_HOST" ]] || usage
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
[[ -f /var/lib/samba/private/sam.ldb ]] || { echo "not a provisioned DC" >&2; exit 1; }

SPN="HTTP/${API_HOST}"

if ! samba-tool user show "$ACCOUNT" >/dev/null 2>&1; then
    echo "==> Creating $ACCOUNT"
    samba-tool user create "$ACCOUNT" --random-password \
        --description="ODM control-plane API service account"
    samba-tool user setexpiry "$ACCOUNT" --noexpiry
fi

echo "==> Registering $SPN"
samba-tool spn add "$SPN" "$ACCOUNT" 2>/dev/null || echo "    (already registered)"

echo "==> Exporting keytab to $KEYTAB"
install -d -m 0750 "$(dirname "$KEYTAB")"
rm -f "$KEYTAB"
samba-tool domain exportkeytab "$KEYTAB" --principal="$SPN"
chmod 0600 "$KEYTAB"

cat <<EOF

Service account ready.

  Account   $ACCOUNT
  SPN       $SPN
  Keytab    $KEYTAB  (mode 0600 — copy to the API host over a secure channel,
                      chown it to the odm user, and never commit it)

Set ODM_KEYTAB to that path. Re-exporting the keytab invalidates the previous
copy, so export once and distribute that file.
EOF
