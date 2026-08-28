#!/usr/bin/env bash
# Install the file-server role: a Kerberos-authenticated SMB share for drive
# maps (CLAUDE.md §5.5). Clients mount it with sec=krb5, so no share
# credential is ever stored on a workstation.

set -euo pipefail

SHARE_NAME=""
SHARE_PATH=""
VALID_GROUP=""

usage() {
    cat >&2 <<'USAGE'
usage: install-file-server-role.sh --share-name <name> --share-path <path> [--valid-group <group>]
USAGE
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --share-name) SHARE_NAME="${2:?}"; shift 2 ;;
        --share-path) SHARE_PATH="${2:?}"; shift 2 ;;
        --valid-group) VALID_GROUP="${2:?}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

[[ -n "$SHARE_NAME" && -n "$SHARE_PATH" ]] || usage
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
[[ "$SHARE_NAME" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "invalid --share-name" >&2; exit 1; }
[[ "$SHARE_PATH" =~ ^/[A-Za-z0-9._/-]{1,255}$ ]] || { echo "invalid --share-path" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends samba acl attr

echo "==> Preparing $SHARE_PATH"
install -d -m 2775 "$SHARE_PATH"
# Extended attributes and ACLs are what let Windows-style permissions survive.
setfacl -d -m g::rwx "$SHARE_PATH" 2>/dev/null || true

CONF="/etc/samba/odm-shares.conf"
touch "$CONF"
if ! grep -q "^\[$SHARE_NAME\]$" "$CONF"; then
    cat >> "$CONF" <<SHARE

[$SHARE_NAME]
    # Managed by Open Directory Manager.
    path = $SHARE_PATH
    read only = no
    vfs objects = acl_xattr
    map acl inherit = yes
    store dos attributes = yes
$( [[ -n "$VALID_GROUP" ]] && printf '    valid users = @%s\n' "$VALID_GROUP" )
SHARE
fi

if ! grep -q "include = $CONF" /etc/samba/smb.conf; then
    printf '\n# Managed by Open Directory Manager\ninclude = %s\n' "$CONF" >> /etc/samba/smb.conf
fi

echo "==> Reloading Samba"
if systemctl is-active --quiet samba-ad-dc; then
    systemctl reload-or-restart samba-ad-dc
else
    systemctl enable --now smbd
    systemctl reload-or-restart smbd
fi

cat <<SUMMARY

File-server role installed.

  Share    //$(hostname -f)/$SHARE_NAME
  Path     $SHARE_PATH
  Access   ${VALID_GROUP:-all authenticated domain users}

Point a drive-map policy at //$(hostname -f)/$SHARE_NAME; the agent mounts it
with sec=krb5, so no credential is stored on the client.
SUMMARY
