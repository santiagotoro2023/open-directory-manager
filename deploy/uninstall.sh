#!/usr/bin/env bash
# Tear down everything Open Directory Manager put on this machine.
#
# This is the reverse of setup.sh and every deploy/install-*-role.sh: stop
# every ODM-managed service, remove every file, directory, database, systemd
# unit, service account and (optionally) package any of them installed, and
# restore what they backed up before editing it in place. What is left
# afterwards is a machine setup.sh has never seen — so setup.sh (or a role
# installer) can run again without tripping over a leftover
# already-provisioned domain, a stale secrets file, an existing database
# role, or a config file half-edited by a previous install.
#
# ------------------------------------------------------------- MAINTAINERS -
#
# A role installed by deploy/install-<role>-role.sh must be removable by this
# script. When you add a new role installer, add its teardown function here
# in the SAME commit — grep this file for "KNOWN_ROLES" and follow the
# pattern of an existing teardown_* function: stop what you started, delete
# what you wrote, back-fill from a .pre-odm.* backup if you left one, and
# only purge the packages *that installer* added. Forgetting this is not
# silent: this script warns at runtime about any install-*-role.sh that has
# no matching entry in KNOWN_ROLES, every time it runs — and CI fails outright
# (`deploy/uninstall.sh --check-roles`, no root needed) until you fix it.
#
# ----------------------------------------------------------------------------

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_USER="odm"
DB_NAME="odm"
DB_USER="odm"
ASSUME_YES="no"
DRY_RUN="no"
PURGE_PACKAGES="no"
PURGE_POSTGRESQL="no"

# Every package a teardown function decides to remove is queued here rather
# than purged on the spot, so services are stopped and configuration is gone
# before apt is asked to touch anything, and so it happens in one
# transaction instead of nine slow ones.
PURGE_LIST=()
# Anything a step could not do, collected rather than fatal: an uninstaller
# that stops halfway through because one step failed leaves the machine in a
# worse state than the one it started in.
FAILURES=()
UNKNOWN_ROLES=()

# Known here means "has a teardown_<slug> function below". Anything else that
# matches deploy/install-*-role.sh is a role this script does not yet know
# how to remove — see the header comment.
KNOWN_ROLES=(dhcp file-server print-server radius remote-desktop-broker
             session-host vpn certificate-authority pxe time)
role_known() {
    local slug="$1" k
    for k in "${KNOWN_ROLES[@]}"; do [[ "$k" == "$slug" ]] && return 0; done
    return 1
}

usage() {
    cat >&2 <<'USAGE'
usage: uninstall.sh [options]

Removes everything Open Directory Manager installed on this machine: the
control plane, the console, the policy agent, everything the agent applied
from policy (browser policy, dconf databases, sudoers, cron, drive maps,
file-type defaults, trust anchors), every server role it finds installed,
the ODM database role and, if this machine is a domain controller, the
domain itself (Samba's directory, Kerberos, DNS — every user,
group, computer and GPO in it). Backups install scripts made before editing a
file in place (*.pre-odm.*) are restored.

  --yes                  do not ask for confirmation
  --dry-run              print what would be removed without removing it
  --purge-packages       also apt-purge the packages each role installed
                         (samba, kea, cups, freeradius, xrdp, ... — never
                         postgresql itself; see --purge-postgresql)
  --purge-postgresql     also apt-purge postgresql and everything in its
                         data directory — EVERY database on this machine,
                         not only ODM's. Only ever pass this on a machine
                         dedicated to ODM.
  --service-user <name>  account the control plane ran as (default: odm)
  --db <name>            ODM's PostgreSQL database name (default: odm)
  --db-user <name>       ODM's PostgreSQL role name (default: odm)
  --check-roles          do nothing but verify every deploy/install-*-role.sh
                         has a matching teardown in this script; needs no
                         root and touches nothing — this is what CI runs

Run it again if it reports failures — every step is safe to repeat.
USAGE
    exit 2
}

CHECK_ROLES_ONLY="no"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes) ASSUME_YES="yes"; shift ;;
        --dry-run) DRY_RUN="yes"; shift ;;
        --purge-packages) PURGE_PACKAGES="yes"; shift ;;
        --purge-postgresql) PURGE_POSTGRESQL="yes"; shift ;;
        --service-user) SERVICE_USER="${2:?}"; shift 2 ;;
        --db) DB_NAME="${2:?}"; shift 2 ;;
        --db-user) DB_USER="${2:?}"; shift 2 ;;
        --check-roles) CHECK_ROLES_ONLY="yes"; shift ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

# No root needed to check a naming convention against the filesystem, and CI
# has neither root nor a machine to uninstall anything from.
if [[ "$CHECK_ROLES_ONLY" == "yes" ]]; then
    status=0
    for installer in "$HERE"/install-*-role.sh; do
        [[ -f "$installer" ]] || continue
        slug="$(basename "$installer")"; slug="${slug#install-}"; slug="${slug%-role.sh}"
        if ! role_known "$slug"; then
            echo "install-$slug-role.sh has no matching teardown_$slug in uninstall.sh" >&2
            status=1
        fi
    done
    [[ $status -eq 0 ]] && echo "every role installer has a matching teardown"
    exit $status
fi

[[ $EUID -eq 0 ]] || { echo "run this as root: sudo deploy/uninstall.sh" >&2; exit 1; }

if [[ -t 1 ]]; then
    B=$'\033[1m'; DIM=$'\033[2m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; GREEN=$'\033[1;32m'; R=$'\033[0m'
else
    B=""; DIM=""; YELLOW=""; RED=""; GREEN=""; R=""
fi

say()  { printf '  %s\n' "$*"; }
note() { printf '  %s%s%s\n' "$DIM" "$*" "$R"; }
warn() { printf '  %s%s%s\n' "$YELLOW" "$*" "$R" >&2; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$R" "$*"; }

# Every removal goes through this. Nothing in this file calls rm, systemctl,
# apt-get, dropdb or dropuser directly, so --dry-run cannot drift out of sync
# with what actually runs: there is exactly one path for each.
run() {
    if [[ "$DRY_RUN" == "yes" ]]; then
        printf '  %swould run:%s %s\n' "$DIM" "$R" "$*"
        return 0
    fi
    if ! "$@"; then
        FAILURES+=("$*")
        return 1
    fi
    return 0
}

# Best-effort: a command that is allowed to fail (the thing was never there,
# the service was never running) without that counting as a failure — unlike
# run, above, this never adds to FAILURES.
maybe() {
    if [[ "$DRY_RUN" == "yes" ]]; then
        printf '  %swould run (best-effort):%s %s\n' "$DIM" "$R" "$*"
        return 0
    fi
    "$@" >/dev/null 2>&1 || true
}

# Restores the oldest *.pre-odm.* backup of $1 over it — the one closest to
# how the file looked before ODM ever touched it — then removes every backup
# of it. A no-op if there is no backup, which is the common case once the
# file's whole directory is being removed anyway.
restore_backup() {
    local target="$1" oldest
    shopt -s nullglob
    local backups=("$target".pre-odm.*)
    shopt -u nullglob
    [[ ${#backups[@]} -gt 0 ]] || return 0
    oldest="$(printf '%s\n' "${backups[@]}" | sort | head -n1)"
    say "Restoring $target from $(basename "$oldest")"
    run cp -a "$oldest" "$target"
    run rm -f "${backups[@]}"
}

installed_unit() { systemctl list-unit-files "$1" --no-legend 2>/dev/null | grep -q .; }
pkg_present() { dpkg -s "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------- detection ---

IS_DC="no"
[[ -f /var/lib/samba/private/sam.ldb ]] && IS_DC="yes"

HAS_API="no"
[[ -f /etc/systemd/system/odm-api.service || -d /opt/odm ]] && HAS_API="yes"

HAS_AGENT="no"
[[ -f /etc/systemd/system/odm-agent.service || -x /usr/sbin/odm-agent ]] && HAS_AGENT="yes"

HAS_POSTGRES_DB="no"
if command -v psql >/dev/null 2>&1 && systemctl is-active --quiet postgresql 2>/dev/null; then
    sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null \
        | grep -q 1 && HAS_POSTGRES_DB="yes"
fi

for installer in "$HERE"/install-*-role.sh; do
    [[ -f "$installer" ]] || continue
    slug="$(basename "$installer")"; slug="${slug#install-}"; slug="${slug%-role.sh}"
    role_known "$slug" || UNKNOWN_ROLES+=("$slug")
done

ROLE_DHCP="no";        [[ -f /etc/kea/kea-dhcp4.conf ]] && ROLE_DHCP="yes"
ROLE_FILE_SERVER="no"; [[ -f /etc/samba/odm-shares.conf ]] && ROLE_FILE_SERVER="yes"
ROLE_PRINT="no";       [[ -f /etc/odm/print-server ]] && ROLE_PRINT="yes"
ROLE_RADIUS="no";      [[ -d /etc/freeradius/3.0/odm ]] && ROLE_RADIUS="yes"
ROLE_RD_BROKER="no";   [[ -f /etc/haproxy/conf.d/odm-remote-desktop.cfg ]] && ROLE_RD_BROKER="yes"
ROLE_SESSION_HOST="no"
[[ -f /etc/xrdp/startwm.sh ]] && grep -q "Open Directory Manager" /etc/xrdp/startwm.sh 2>/dev/null \
    && ROLE_SESSION_HOST="yes"
ROLE_VPN="no";         [[ -f /etc/wireguard/odm-external-interface ]] && ROLE_VPN="yes"
ROLE_CA="no";          [[ -d /var/lib/odm/ca ]] && ROLE_CA="yes"
ROLE_PXE="no";         [[ -f /etc/dnsmasq.d/odm-pxe.conf || -d /srv/odm-preseed ]] && ROLE_PXE="yes"
ROLE_TIME="no";        [[ -f /etc/odm/time-server ]] && ROLE_TIME="yes"

# ------------------------------------------------------------- reporting ---

clear 2>/dev/null || true
cat <<BANNER
${B}Open Directory Manager — uninstall${R}

  This removes everything ODM put on this machine so it can be set up again
  as if it were new. ${YELLOW}It does not touch other machines${R} — a domain
  controller removed here still exists to every client that joined it, until
  they are reinstalled or leave the domain another way.

BANNER

say "${B}Found on this machine:${R}"
[[ "$HAS_API" == "yes" ]] && say "  • Control plane and console ($([[ -d /opt/odm ]] && echo /opt/odm || echo "no venv found"))"
[[ "$HAS_AGENT" == "yes" ]] && say "  • Policy agent, and the settings it applied from policy"
if [[ "$IS_DC" == "yes" ]]; then
    say "  • ${RED}A provisioned domain controller — its directory, GPOs and DNS zones${R}"
fi
[[ "$HAS_POSTGRES_DB" == "yes" ]] && say "  • PostgreSQL database \"$DB_NAME\" and role \"$DB_USER\""
[[ "$ROLE_DHCP" == "yes" ]] && say "  • DHCP role (Kea)"
[[ "$ROLE_FILE_SERVER" == "yes" ]] && say "  • File-server role"
[[ "$ROLE_PRINT" == "yes" ]] && say "  • Print-server role (CUPS)"
[[ "$ROLE_RADIUS" == "yes" ]] && say "  • RADIUS role (FreeRADIUS)"
[[ "$ROLE_RD_BROKER" == "yes" ]] && say "  • Remote desktop broker role (HAProxy)"
[[ "$ROLE_SESSION_HOST" == "yes" ]] && say "  • Remote desktop session host role (xrdp)"
[[ "$ROLE_VPN" == "yes" ]] && say "  • VPN role (WireGuard)"
[[ "$ROLE_CA" == "yes" ]] && say "  • Certificate-authority role"
[[ "$ROLE_PXE" == "yes" ]] && say "  • PXE role (dnsmasq, nginx)"
[[ "$ROLE_TIME" == "yes" ]] && say "  • Time role (chrony)"

if [[ "$HAS_API" == "no" && "$HAS_AGENT" == "no" && "$IS_DC" == "no" && "$HAS_POSTGRES_DB" == "no" \
        && "$ROLE_DHCP" == "no" && "$ROLE_FILE_SERVER" == "no" && "$ROLE_PRINT" == "no" \
        && "$ROLE_RADIUS" == "no" && "$ROLE_RD_BROKER" == "no" && "$ROLE_SESSION_HOST" == "no" \
        && "$ROLE_VPN" == "no" && "$ROLE_CA" == "no" && "$ROLE_PXE" == "no" \
        && "$ROLE_TIME" == "no" ]]; then
    say "  (nothing — this machine looks clean already)"
fi
echo

if [[ ${#UNKNOWN_ROLES[@]} -gt 0 ]]; then
    for slug in "${UNKNOWN_ROLES[@]}"; do
        warn "install-$slug-role.sh has no matching teardown in this script; it will not be removed."
    done
    warn "See the header comment in uninstall.sh."
    echo
fi

[[ "$PURGE_PACKAGES" == "yes" ]] && note "Packages each found role installed will also be apt-purged."
[[ "$PURGE_POSTGRESQL" == "yes" ]] && \
    warn "postgresql will be apt-purged — every database on this machine is deleted, not only ODM's."
[[ "$DRY_RUN" == "yes" ]] && note "Dry run: nothing below actually happens."
echo

if [[ "$ASSUME_YES" != "yes" && "$DRY_RUN" != "yes" ]]; then
    HOST_SHORT="$(hostname -s 2>/dev/null || hostname)"
    if [[ ! -t 0 ]]; then
        echo "Refusing to run non-interactively without --yes." >&2
        exit 1
    fi
    read -rp "Type this machine's name ($HOST_SHORT) to remove all of the above: " CONFIRM
    [[ "$CONFIRM" == "$HOST_SHORT" ]] || { echo "Names did not match; nothing was changed." >&2; exit 1; }
fi

echo
say "${B}Removing…${R}"

# ------------------------------------------------------------------ roles --

teardown_dhcp() {
    [[ "$ROLE_DHCP" == "yes" ]] || return 0
    say "DHCP role"
    maybe systemctl disable --now kea-dhcp4-server kea-dhcp-ddns-server kea-ctrl-agent
    run rm -f /etc/kea/kea-dhcp4.conf /etc/kea/kea-dhcp-ddns.conf /etc/kea/kea-ctrl-agent.conf
    run rm -f /etc/kea/kea-api-user /etc/kea/kea-api-password
    shopt -s nullglob
    local kea_backups=(/etc/kea/*.conf.pre-odm.*)
    shopt -u nullglob
    [[ ${#kea_backups[@]} -gt 0 ]] && run rm -f "${kea_backups[@]}"
    run rm -f /etc/odm/kea-ddns.keytab
    run rm -f /etc/apparmor.d/local/usr.sbin.kea-dhcp4 /etc/apparmor.d/local/usr.sbin.kea-dhcp-ddns
    maybe apparmor_parser -R /etc/apparmor.d/usr.sbin.kea-dhcp4
    maybe apparmor_parser -R /etc/apparmor.d/usr.sbin.kea-dhcp-ddns
    run rm -f /etc/tmpfiles.d/odm-kea.conf
    run rm -rf /var/lib/kea
    [[ "$PURGE_PACKAGES" == "yes" ]] && PURGE_LIST+=(kea-dhcp4-server kea-ctrl-agent kea-dhcp-ddns-server kea-common)
    ok "DHCP role removed"
}

teardown_file_server() {
    [[ "$ROLE_FILE_SERVER" == "yes" ]] || return 0
    say "File-server role"
    if [[ -f /etc/samba/smb.conf ]]; then
        run sed -i '/^# Managed by Open Directory Manager$/{N;/include = \/etc\/samba\/odm-shares.conf/d}' \
            /etc/samba/smb.conf
    fi
    run rm -f /etc/samba/odm-shares.conf
    if [[ "$IS_DC" == "no" ]]; then
        maybe systemctl disable --now smbd
        [[ "$PURGE_PACKAGES" == "yes" ]] && PURGE_LIST+=(samba)
    fi
    note "  Share directories on disk are left in place — delete them yourself if they should go."
    ok "File-server role removed"
}

teardown_print_server() {
    [[ "$ROLE_PRINT" == "yes" ]] || return 0
    say "Print-server role"
    maybe systemctl disable --now cups avahi-daemon
    restore_backup /etc/cups/cupsd.conf
    run rm -f /etc/cups/cupsd.conf.d/odm-access.conf
    run rm -f /etc/odm/print-server
    [[ "$PURGE_PACKAGES" == "yes" ]] && \
        PURGE_LIST+=(cups cups-ipp-utils cups-filters avahi-daemon avahi-utils \
                     printer-driver-gutenprint printer-driver-postscript-hp)
    ok "Print-server role removed"
}

teardown_radius() {
    [[ "$ROLE_RADIUS" == "yes" ]] || return 0
    say "RADIUS role"
    maybe systemctl disable --now freeradius
    maybe deluser freerad winbindd_priv
    restore_backup /etc/freeradius/3.0/mods-available/eap
    restore_backup /etc/freeradius/3.0/clients.conf
    run rm -rf /etc/freeradius/3.0/odm /etc/freeradius/3.0/certs/server.key /etc/freeradius/3.0/certs/server.pem
    [[ "$PURGE_PACKAGES" == "yes" ]] && PURGE_LIST+=(freeradius freeradius-utils)
    ok "RADIUS role removed"
}

teardown_remote_desktop_broker() {
    [[ "$ROLE_RD_BROKER" == "yes" ]] || return 0
    say "Remote desktop broker role"
    maybe systemctl disable --now haproxy
    run rm -f /etc/haproxy/conf.d/odm-remote-desktop.cfg /etc/systemd/system/haproxy.service.d/odm.conf
    maybe rmdir /etc/systemd/system/haproxy.service.d
    maybe systemctl daemon-reload
    [[ "$PURGE_PACKAGES" == "yes" ]] && PURGE_LIST+=(haproxy)
    ok "Remote desktop broker role removed"
}

teardown_session_host() {
    [[ "$ROLE_SESSION_HOST" == "yes" ]] || return 0
    say "Remote desktop session host role"
    maybe systemctl disable --now xrdp xrdp-sesman
    restore_backup /etc/xrdp/sesman.ini
    run rm -f /etc/xrdp/startwm.sh /etc/xrdp/cert.pem /etc/xrdp/key.pem /etc/X11/Xwrapper.config

    # The PAM line first, and whether or not xrdp is being purged: it names a
    # script that is about to be removed, and "session required" with a
    # missing program refuses every sign-in through xrdp. Leaving it behind
    # would take remote desktop down on a machine somebody kept xrdp on.
    if [[ -f /etc/pam.d/xrdp-sesman ]]; then
        run sed -i '\#/etc/odm/rd-profile.sh#d' /etc/pam.d/xrdp-sesman
        run sed -i '/Managed by Open Directory Manager/d' /etc/pam.d/xrdp-sesman
    fi

    # Anybody still signed in has a profile disk mounted over their home and
    # the share it came from mounted under /run. Both go, so the loop devices
    # are released and the empty homes do not look like local accounts.
    shopt -s nullglob
    local home
    for home in /home/*; do
        mountpoint -q "$home" 2>/dev/null || continue
        maybe umount "$home"
        maybe umount -l "$home"
        maybe rmdir "$home"
    done
    shopt -u nullglob
    mountpoint -q /run/odm/profiles 2>/dev/null && maybe umount -l /run/odm/profiles

    [[ "$PURGE_PACKAGES" == "yes" ]] && PURGE_LIST+=(xrdp xorgxrdp xfce4 xfce4-goodies xfce4-terminal)
    ok "Remote desktop session host role removed"
}

# Everything the policy agent wrote on this machine that is not under
# /etc/odm or /var/lib/odm.
#
# These are not a role: any machine carrying the agent can have them, put
# there by whichever policy objects reached it. Left behind they are a
# desktop that still has a locked background, a browser that still has managed
# policy, and a login screen still showing a banner for a domain that is gone.
teardown_policy_artefacts() {
    [[ "$HAS_AGENT" == "yes" ]] || return 0
    say "Settings the agent applied"

    # Browsers. Each vendor's documented managed-policy location.
    run rm -f /etc/chromium/policies/managed/odm.json \
              /etc/opt/chrome/policies/managed/odm.json \
              /etc/firefox/policies/policies.json

    # Desktop and login screen, in every database the agent writes to.
    run rm -f /etc/dconf/db/odm.d/00-odm-desktop \
              /etc/dconf/db/odm.d/locks/odm-desktop \
              /etc/dconf/db/gdm.d/00-odm-login-screen \
              /etc/dconf/profile/gdm \
              /usr/share/gdm/dconf/95-odm-login-screen
    if [[ -f /etc/dconf/profile/user ]] \
            && grep -q '^system-db:odm$' /etc/dconf/profile/user 2>/dev/null; then
        run rm -f /etc/dconf/profile/user
    fi
    maybe rmdir /etc/dconf/db/odm.d/locks /etc/dconf/db/odm.d
    maybe dconf update
    [[ -x /usr/share/gdm/generate-config ]] && maybe /usr/share/gdm/generate-config

    # Which program opens which kind of file.
    run rm -f /etc/xdg/mimeapps.list /usr/share/mime/packages/odm-file-types.xml
    command -v update-mime-database >/dev/null 2>&1 && maybe update-mime-database /usr/share/mime

    # Access control, scheduled work, deployed scripts and trust anchors.
    shopt -s nullglob
    local leftovers=(/etc/sudoers.d/odm-* /etc/security/odm-access-* /etc/cron.d/odm-*
                     /usr/local/share/ca-certificates/odm-* /etc/ssh/sshd_config.d/50-odm.conf
                     /etc/apt/apt.conf.d/20odm-auto-upgrades
                     /etc/apt/apt.conf.d/51odm-unattended-upgrades
                     /etc/pwquality.conf.d/50-odm.conf /etc/security/pwquality.conf.d/50-odm.conf
                     /etc/systemd/system/odm-firewall.service
                     /etc/systemd/system/odm-scripts.service)
    shopt -u nullglob
    if [[ ${#leftovers[@]} -gt 0 ]]; then
        maybe systemctl disable --now odm-firewall odm-scripts
        run rm -f "${leftovers[@]}"
        command -v update-ca-certificates >/dev/null 2>&1 && maybe update-ca-certificates --fresh
    fi

    # Drive maps are systemd mount units, named after where they mount.
    shopt -s nullglob
    local mounts=(/etc/systemd/system/*.automount /etc/systemd/system/*.mount)
    shopt -u nullglob
    local unit
    for unit in "${mounts[@]}"; do
        grep -q "Open Directory Manager" "$unit" 2>/dev/null || continue
        maybe systemctl disable --now "$(basename "$unit")"
        run rm -f "$unit"
    done
    maybe systemctl daemon-reload

    ok "Applied settings removed"
}

teardown_vpn() {
    [[ "$ROLE_VPN" == "yes" ]] || return 0
    say "VPN role"
    run rm -f /etc/sysctl.d/99-odm-vpn.conf
    maybe sysctl -q --system
    run rm -rf /etc/wireguard
    [[ "$PURGE_PACKAGES" == "yes" ]] && PURGE_LIST+=(wireguard-tools)
    ok "VPN role removed"
}

teardown_certificate_authority() {
    # /var/lib/odm/ca is removed with the rest of /var/lib/odm in the core
    # teardown below; nothing role-specific runs anywhere else.
    [[ "$ROLE_CA" == "yes" ]] && ok "Certificate-authority role removed"
}

teardown_time() {
    [[ "$ROLE_TIME" == "yes" ]] || return 0
    say "Time role"
    run rm -f /etc/chrony/conf.d/odm-time.conf /etc/odm/time-server
    # chrony itself is left running on its own configuration: a machine with
    # no time source is a machine that stops being able to sign in, which is
    # not what uninstalling ODM should do.
    maybe systemctl try-restart chrony
    [[ "$PURGE_PACKAGES" == "yes" ]] && PURGE_LIST+=(chrony)
    ok "Time role removed"
}

teardown_pxe() {
    [[ "$ROLE_PXE" == "yes" ]] || return 0
    say "PXE role"
    maybe systemctl disable --now dnsmasq
    run rm -f /etc/dnsmasq.d/odm-pxe.conf
    run rm -f /etc/nginx/sites-available/odm-pxe /etc/nginx/sites-enabled/odm-pxe
    maybe systemctl reload nginx
    run rm -rf /srv/tftp /srv/odm-preseed
    [[ "$PURGE_PACKAGES" == "yes" ]] && PURGE_LIST+=(dnsmasq nginx-light)
    note "  /etc/nginx/sites-enabled/default was removed when this role was installed and is not restored."
    ok "PXE role removed"
}

teardown_dhcp
teardown_file_server
teardown_print_server
teardown_radius
teardown_remote_desktop_broker
teardown_session_host
teardown_vpn
teardown_certificate_authority
teardown_pxe
teardown_time
teardown_policy_artefacts

# -------------------------------------------------------------- core ODM --

if [[ "$HAS_AGENT" == "yes" ]]; then
    say "Policy agent"
    maybe systemctl disable --now odm-agent
    run rm -f /etc/systemd/system/odm-agent.service
    run rm -f /usr/sbin/odm-agent /usr/sbin/odm-client-install
    run rm -rf /usr/lib/odm
    if [[ -L /etc/systemd/system-generators/systemd-ssh-generator ]] \
            && [[ "$(readlink /etc/systemd/system-generators/systemd-ssh-generator)" == "/dev/null" ]]; then
        run rm -f /etc/systemd/system-generators/systemd-ssh-generator
    fi
    ok "Policy agent removed"
fi

if [[ "$HAS_API" == "yes" ]]; then
    say "Control plane and console"
    maybe systemctl disable --now odm-api
    run rm -f /etc/systemd/system/odm-api.service
    run rm -rf /opt/odm
    ok "Control plane and console removed"
fi

maybe systemctl daemon-reload

if [[ "$HAS_POSTGRES_DB" == "yes" ]]; then
    say "PostgreSQL database \"$DB_NAME\" and role \"$DB_USER\""
    run sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB_NAME\""
    run sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS \"$DB_USER\""
    ok "Database removed"
fi

if [[ "$PURGE_POSTGRESQL" == "yes" ]] && pkg_present postgresql; then
    say "PostgreSQL server (every database on this machine)"
    maybe systemctl disable --now postgresql
    run apt-get purge -y postgresql postgresql-common >/dev/null
    run rm -rf /var/lib/postgresql /etc/postgresql
    ok "PostgreSQL server purged"
fi

# ---------------------------------------------------------- domain (DC) ---

if [[ "$IS_DC" == "yes" ]]; then
    say "${RED}Domain controller: directory, Kerberos, DNS${R}"
    maybe systemctl disable --now samba-ad-dc smbd nmbd winbind
    run rm -rf /var/lib/samba /etc/samba /var/cache/samba
    run rm -f /etc/krb5.conf /etc/krb5.keytab

    if installed_unit systemd-resolved.service && [[ ! -L /etc/resolv.conf ]]; then
        say "  Handing DNS back to systemd-resolved"
        maybe systemctl enable --now systemd-resolved
        run ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
    fi

    if [[ "$PURGE_PACKAGES" == "yes" ]]; then
        for p in samba samba-common-bin samba-ad-dc samba-ad-provision python3-samba \
                 smbclient winbind libnss-winbind libpam-winbind ldb-tools; do
            pkg_present "$p" && PURGE_LIST+=("$p")
        done
    fi
    ok "Domain removed — every other machine that joined it still believes it exists"
fi

restore_backup /etc/hosts
run rm -f /etc/apt/apt.conf.d/99-odm-lock-timeout

# -------------------------------------------------------------- leftover --

run rm -rf /etc/odm /var/lib/odm /var/backups/odm
run rm -f /var/log/odm-agent-install.log

if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    UID_N="$(id -u "$SERVICE_USER")"
    if [[ "$UID_N" -lt 1000 ]]; then
        say "Service account \"$SERVICE_USER\""
        run userdel "$SERVICE_USER"
        maybe groupdel "$SERVICE_USER"
        ok "Service account removed"
    else
        warn "\"$SERVICE_USER\" (uid $UID_N) looks like a real login account, not the one setup.sh"
        warn "created — leaving it alone. Remove it yourself if it was only ever the service account."
    fi
fi

if [[ ${#PURGE_LIST[@]} -gt 0 ]]; then
    say "Purging packages: ${PURGE_LIST[*]}"
    run apt-get purge -y "${PURGE_LIST[@]}" >/dev/null
    ok "Packages purged"
    note "Nothing else was removed automatically; run apt-get autoremove if you want their"
    note "no-longer-needed dependencies gone too."
fi

# --------------------------------------------------------------- summary --

echo
if [[ "$DRY_RUN" == "yes" ]]; then
    printf '%s  Dry run finished — nothing was changed.%s\n' "$B" "$R"
elif [[ ${#FAILURES[@]} -eq 0 ]]; then
    printf '%s  Done. This machine has nothing of Open Directory Manager left on it that\n' "$GREEN$B"
    printf '  setup.sh does not expect to find.%s\n' "$R"
else
    printf '%s  Finished, but %d step(s) reported a problem:%s\n' "$YELLOW$B" "${#FAILURES[@]}" "$R"
    for f in "${FAILURES[@]}"; do printf '    %s\n' "$f"; done
    printf '  Run uninstall.sh again — every step here is safe to repeat.\n'
fi

if [[ "$IS_DC" == "yes" && "$DRY_RUN" != "yes" ]]; then
    echo
    warn "Any machine that joined this domain still has a computer account and a machine"
    warn "keytab for a domain that no longer exists here. Reinstall or leave the domain on"
    warn "each of them before pointing them at a freshly provisioned one of the same name."
fi
