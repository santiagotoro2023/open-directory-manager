#!/usr/bin/env bash
# Install the file-server role: Samba configured as a domain member, ready to
# carry shares (CLAUDE.md §5.5).
#
# The role is the server. The shares themselves are created and edited under
# File Shares in the console, which is what lets one server carry several and
# lets their permissions be changed without reinstalling anything.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

# Shared helpers: apt that survives a controller, and a dpkg that recovers.
# shellcheck source=odm-role-common.sh
. "$(dirname "$0")/odm-role-common.sh"


odm_apt_install samba acl attr

CONF="/etc/samba/odm-shares.conf"
if [[ ! -f "$CONF" ]]; then
    printf '# Managed by Open Directory Manager. Edits here are overwritten.\n' > "$CONF"
    chmod 0644 "$CONF"
fi

if ! grep -q "include = $CONF" /etc/samba/smb.conf 2>/dev/null; then
    printf '\n# Managed by Open Directory Manager\ninclude = %s\n' "$CONF" >> /etc/samba/smb.conf
fi

echo "==> Starting the file server"
# A domain controller serves SMB from samba-ad-dc; a member server from smbd.
if systemctl is-active --quiet samba-ad-dc; then
    systemctl reload-or-restart samba-ad-dc
else
    systemctl enable --now smbd
    systemctl reload-or-restart smbd
fi

cat <<SUMMARY

File-server role installed on $(hostname -f).

Create shares under File Shares in the console. Drive-map policies can point
at them as soon as they are active.
SUMMARY
