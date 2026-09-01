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
SERVICE_USER="odm"

usage() {
    cat >&2 <<'EOF'
usage: create-api-service-account.sh --realm <dns.domain> --api-host <fqdn> [--keytab <path>]
                                     [--service-user <name>]
EOF
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --realm) REALM="${2:?}"; shift 2 ;;
        --api-host) API_HOST="${2:?}"; shift 2 ;;
        --keytab) KEYTAB="${2:?}"; shift 2 ;;
        --service-user) SERVICE_USER="${2:?}"; shift 2 ;;
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

# odm.<domain> is where a joined machine looks for the console, and the
# domain's DNS publishes it. Kerberos has to know the console answers to that
# name too, or every agent on every member gets
#
#   KDC_ERR_S_PRINCIPAL_UNKNOWN ... HTTP/odm.<domain>
CONVENTION_SPN="HTTP/odm.${REALM}"
if [[ "$CONVENTION_SPN" != "$SPN" ]]; then
    echo "==> Registering $CONVENTION_SPN"
    samba-tool spn add "$CONVENTION_SPN" "$ACCOUNT" 2>/dev/null ||
        echo "    (already registered)"
fi

echo "==> Delegating directory write rights"
# ODM manages users, groups, computers and OUs on behalf of an authenticated
# domain admin, so the service account needs create/delete/read/write on child
# objects beneath the domain head — and nothing more. It is deliberately NOT
# granted WriteDacl, WriteOwner or Delete Tree, and it is not a Domain Admin
# (CLAUDE.md §6).
# winbind runs inside samba-ad-dc and needs a moment after a fresh
# provision, so give it one rather than failing on a cold start.
SID=""
for _ in $(seq 1 15); do
    # || true: wbinfo fails while Samba is still starting, which is the
    # case this loop exists for. Without it the script ends here instead of
    # retrying and then explaining itself.
    SID="$(wbinfo -n "$ACCOUNT" 2>/dev/null | awk '{print $1}' || true)"
    [[ -n "$SID" ]] && break
    sleep 2
done
if [[ -z "$SID" ]]; then
    cat >&2 <<MISSING

Could not resolve the security identifier for $ACCOUNT.

That normally means samba-ad-dc is not running yet. Check it and run this
again:

    systemctl status samba-ad-dc
    wbinfo -n $ACCOUNT

MISSING
    exit 1
fi
BASE_DN="$(printf 'DC=%s' "${REALM//./,DC=}")"
samba-tool dsacl set --objectdn="$BASE_DN" --sddl="(A;CI;CCDCLCRPWP;;;${SID})"

echo "==> Delegating password resets"
# Writing unicodePwd is not a property write, whatever the attribute looks
# like: AD gates it behind the Reset Password control-access right, and
# without it creating a user succeeds and then fails with
# "insufficientAccessRights ... during LDB_MODIFY (50)", leaving a disabled
# account behind. CI so it reaches the user objects under the domain, not
# just the domain object itself.
samba-tool dsacl set --objectdn="$BASE_DN" \
    --sddl="(OA;CI;CR;00299570-246d-11d0-a768-00aa006e0529;;${SID})"

echo "==> Delegating replication monitoring"
# Reading replication state and forcing a run are separate control-access
# rights, and neither comes with the object rights above. Without them the
# Operations page reports WERR_DS_DRA_ACCESS_DENIED. Granted individually
# rather than by making the account a Domain Admin.
# All four, because a DRSUAPI bind is checked before the operation is: showrepl
# opens the connection, then reads topology, and being granted only the second
# still fails at the first with WERR_DS_DRA_ACCESS_DENIED.
#   f98340fb-…  Monitor Active Directory Replication  (read the topology)
#   1131f6ab-…  Replication Synchronization           (force a run)
#   1131f6aa-…  Replicating Directory Changes         (bind)
#   1131f6ac-…  Manage Replication Topology           (read what showrepl reads)
for RIGHT in f98340fb-7c5b-4cdb-a00b-2ebdfa115a96 \
             1131f6ab-9c07-11d1-f79f-00c04fc2dcd2 \
             1131f6aa-9c07-11d1-f79f-00c04fc2dcd2 \
             1131f6ac-9c07-11d1-f79f-00c04fc2dcd2; do
    samba-tool dsacl set --objectdn="$BASE_DN" --sddl="(OA;;CR;${RIGHT};;${SID})"
done

echo "==> Exporting keytab to $KEYTAB"
install -d -m 0750 "$(dirname "$KEYTAB")"
rm -f "$KEYTAB"
# Two principals, two jobs. The SPN accepts tickets from browsers and agents.
# The account itself is what the control plane authenticates *as* when it binds
# to the directory: AD issues a ticket-granting ticket to an account, never to
# one of its service principal names, so a keytab holding only the SPN gets
# "client not found in Kerberos database".
samba-tool domain exportkeytab "$KEYTAB" --principal="$SPN"
[[ "$CONVENTION_SPN" == "$SPN" ]] ||
    samba-tool domain exportkeytab "$KEYTAB" --principal="$CONVENTION_SPN"
samba-tool domain exportkeytab "$KEYTAB" --principal="$ACCOUNT"

for PRINCIPAL in "$SPN" "$ACCOUNT"; do
    if ! klist -k "$KEYTAB" 2>/dev/null | grep -qi -- "$PRINCIPAL@"; then
        echo "$KEYTAB has no entry for $PRINCIPAL; the control plane cannot start" >&2
        exit 1
    fi
done

# The control plane runs unprivileged and authenticates with this keytab, so
# the service user must be able to read it — and nobody else.
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    chown "root:$SERVICE_USER" "$KEYTAB"
    chgrp "$SERVICE_USER" "$(dirname "$KEYTAB")"
    chmod 0640 "$KEYTAB"
else
    chmod 0600 "$KEYTAB"
    echo "    note: the $SERVICE_USER user does not exist yet;" >&2
    echo "          re-run after installing the control plane, or chown the keytab" >&2
fi

# The DC's LDAPS certificate is signed by a CA under Samba's private
# directory, which is root-only. Publish a readable copy for clients.
SAMBA_CA="/var/lib/samba/private/tls/ca.pem"
if [[ -f "$SAMBA_CA" ]]; then
    install -d -m 0755 /etc/odm/tls
    install -m 0644 "$SAMBA_CA" /etc/odm/tls/dc-ca.pem
    echo "==> Published the directory CA to /etc/odm/tls/dc-ca.pem"
fi

cat <<EOF

Service account ready.

  Account   $ACCOUNT
  SPN       $SPN
  Rights    create/delete/read/write child objects under $BASE_DN
  Keytab    $KEYTAB  (readable by the odm service user only —
                      copy to the API host over a secure channel if the
                      control plane runs elsewhere, and never commit it)
  CA        /etc/odm/tls/dc-ca.pem  (validates the controller's LDAPS certificate)

Set ODM_KEYTAB to that path. Re-exporting the keytab invalidates the previous
copy, so export once and distribute that file.
EOF
