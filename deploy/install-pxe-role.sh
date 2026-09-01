#!/usr/bin/env bash
# Install the PXE role: unattended Debian installation that joins the domain
# on first boot (CLAUDE.md §4).
#
# dnsmasq runs as a proxy DHCP server, so it advertises network boot without
# taking over address assignment from the DHCP role or an existing server.

set -euo pipefail

INTERFACE=""
DOMAIN=""
SUITE="trixie"
TOKEN=""
MIRROR="http://deb.debian.org/debian"
JOIN_OU=""
LOCAL_ADMIN="localadmin"
PASSWORD_HASH=""
CLIENT_BINARY="/usr/sbin/odm-client-install"
SCOPES=""
TFTP_ROOT="/srv/tftp"
SEED_ROOT="/srv/odm-preseed"

usage() {
    cat >&2 <<'USAGE'
usage: install-pxe-role.sh --interface <iface> --domain <domain> --enrolment-token <token>
                           [--suite bookworm|trixie] [--mirror <url>] [--ou <dn>]
                           [--local-admin <name>] [--local-password-hash <hash>]
                           [--client-binary <path>]

  --interface        the network interface to serve boot requests on
  --domain           the domain installed machines join
  --enrolment-token  a multi-use token the installed machine enrols with
  --ou               container the installed machine's account is created in
  --mirror           a snapshot.debian.org URL pins the installed version
  --local-password-hash
                     crypt(3) hash for the local administrator. One is
                     generated and printed when this is omitted.
  --scopes           comma-separated network addresses to advertise boot in,
                     e.g. 10.10.0.0,10.20.0.0. Without it, boot is offered to
                     everything on the interface.
USAGE
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --interface) INTERFACE="${2:?}"; shift 2 ;;
        --domain) DOMAIN="${2:?}"; shift 2 ;;
        --suite) SUITE="${2:?}"; shift 2 ;;
        --enrolment-token) TOKEN="${2:?}"; shift 2 ;;
        --mirror) MIRROR="${2:?}"; shift 2 ;;
        --ou) JOIN_OU="${2:?}"; shift 2 ;;
        --local-admin) LOCAL_ADMIN="${2:?}"; shift 2 ;;
        --local-password-hash) PASSWORD_HASH="${2:?}"; shift 2 ;;
        --client-binary) CLIENT_BINARY="${2:?}"; shift 2 ;;
        --scopes) SCOPES="${2:?}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

# The interface installs are served on is a property of this machine, not a
# decision an operator should have to look up: default to the one carrying the
# default route, which on a single-homed server is the only one there is.
if [[ -z "$INTERFACE" ]]; then
    INTERFACE="$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}' || true)"
    [[ -n "$INTERFACE" ]] || {
        echo "no default route to pick an interface from; pass --interface" >&2
        exit 1
    }
    echo "==> Serving boot on $INTERFACE (the default route's interface)"
fi

[[ -n "$DOMAIN" && -n "$TOKEN" ]] || usage
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

# Shared helpers: apt that survives a controller, and a dpkg that recovers.
# shellcheck source=odm-role-common.sh
. "$(dirname "$0")/odm-role-common.sh"

[[ "$INTERFACE" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || { echo "invalid --interface" >&2; exit 1; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || { echo "invalid --domain" >&2; exit 1; }
[[ "$SUITE" =~ ^(bookworm|trixie)$ ]] || { echo "--suite must be bookworm or trixie" >&2; exit 1; }
[[ "$TOKEN" =~ ^[A-Za-z0-9_-]{16,128}$ ]] || { echo "invalid --enrolment-token" >&2; exit 1; }
[[ "$MIRROR" =~ ^https?://[A-Za-z0-9./_-]{3,200}$ ]] || { echo "invalid --mirror" >&2; exit 1; }
[[ "$LOCAL_ADMIN" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "invalid --local-admin" >&2; exit 1; }
# A distinguished name contains spaces, so the pattern has to be a variable:
# an unquoted space inside [[ =~ ]] is a syntax error.
OU_RE='^[A-Za-z0-9=,._ -]{3,512}$'
[[ -z "$JOIN_OU" || "$JOIN_OU" =~ $OU_RE ]] || { echo "invalid --ou" >&2; exit 1; }
[[ -z "$SCOPES" || "$SCOPES" =~ ^[0-9./,]{7,255}$ ]] || { echo "invalid --scopes" >&2; exit 1; }

# An installed machine has to fetch odm-client-install from somewhere, or its
# join silently does nothing. Publishing it is part of installing the role,
# not a note in the summary for somebody to act on later.
if [[ ! -x "$CLIENT_BINARY" ]]; then
    cat >&2 <<MISSING

$CLIENT_BINARY is not here, so an installed machine would have nothing to
join the domain with.

Build it and point at it:

    (cd client-join && go build -o /tmp/odm-client-install ./cmd/odm-client-install)
    sudo deploy/install-pxe-role.sh ... --client-binary /tmp/odm-client-install

MISSING
    exit 1
fi

echo "==> Installing packages"
odm_apt_install dnsmasq nginx-light curl ca-certificates openssl

echo "==> Fetching the $SUITE netboot image"
install -d -m 0755 "$TFTP_ROOT"
NETBOOT="$MIRROR/dists/$SUITE/main/installer-amd64/current/images/netboot/netboot.tar.gz"
curl -fsSL "$NETBOOT" -o /tmp/netboot.tar.gz
tar xzf /tmp/netboot.tar.gz -C "$TFTP_ROOT"
rm -f /tmp/netboot.tar.gz

# A placeholder hash is not a password: the installer either refuses it or
# creates an account nobody can use. Generate a real one and say what it is.
GENERATED_PASSWORD=""
if [[ -z "$PASSWORD_HASH" ]]; then
    GENERATED_PASSWORD="$(odm_random_password 20)"
    PASSWORD_HASH="$(openssl passwd -6 "$GENERATED_PASSWORD")"
fi

echo "==> Writing the preseed"
install -d -m 0755 "$SEED_ROOT"
umask 022
cat > "$SEED_ROOT/odm.cfg" <<PRESEED
# Managed by Open Directory Manager.
d-i debian-installer/locale string en_US.UTF-8
d-i keyboard-configuration/xkb-keymap select us

d-i netcfg/choose_interface select auto
d-i netcfg/get_domain string $DOMAIN
d-i netcfg/hostname string debian

d-i mirror/country string manual
d-i mirror/http/hostname string $(printf '%s' "$MIRROR" | sed -E 's#^https?://##; s#/.*##')
d-i mirror/http/directory string /debian
d-i mirror/http/proxy string

d-i passwd/root-login boolean false
d-i passwd/user-fullname string Local Administrator
d-i passwd/username string $LOCAL_ADMIN
d-i passwd/user-password-crypted password $PASSWORD_HASH

d-i clock-setup/utc boolean true
d-i time/zone string Etc/UTC
d-i clock-setup/ntp boolean true

d-i partman-auto/method string regular
d-i partman-auto/choose_recipe select atomic
d-i partman/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true

tasksel tasksel/first multiselect standard, ssh-server
d-i pkgsel/include string sssd-ad sssd-tools samba-common-bin krb5-user cifs-utils keyutils nftables dconf-cli curl
d-i pkgsel/upgrade select full-upgrade
popularity-contest popcon/participate boolean false

d-i grub-installer/only_debian boolean true
d-i grub-installer/bootdev string default
d-i finish-install/reboot_in_progress note

# Enrol with the domain on first boot.
d-i preseed/late_command string \\
    in-target /bin/sh -c "curl -fsSL http://$(hostname -f)/odm-client-install -o /usr/sbin/odm-client-install"; \\
    in-target chmod 0755 /usr/sbin/odm-client-install; \\
    in-target /usr/sbin/odm-client-install --domain $DOMAIN --otp $TOKEN${JOIN_OU:+ --ou "$JOIN_OU"} --unattended
PRESEED
chmod 0644 "$SEED_ROOT/odm.cfg"

echo "==> Publishing the client installer"
install -m 0755 "$CLIENT_BINARY" "$SEED_ROOT/odm-client-install"

echo "==> Serving the preseed over HTTP"
cat > /etc/nginx/sites-available/odm-pxe <<NGINX
# Managed by Open Directory Manager.
server {
    listen 80 default_server;
    root $SEED_ROOT;
    autoindex off;
    location / {
        try_files \$uri =404;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/odm-pxe /etc/nginx/sites-enabled/odm-pxe
rm -f /etc/nginx/sites-enabled/default
systemctl enable --now nginx
systemctl reload nginx

echo "==> Configuring proxy DHCP and TFTP"
# Which networks are offered boot at all.
#
# Scoping this matters: a boot server that answers everything on its interface
# will offer to reinstall a workstation that happened to PXE-boot by accident.
# Naming the networks keeps deployment on the network built for it.
RANGES=""
if [[ -n "$SCOPES" ]]; then
    IFS=',' read -ra SCOPE_LIST <<< "$SCOPES"
    for SCOPE in "${SCOPE_LIST[@]}"; do
        SCOPE="${SCOPE%%/*}"
        [[ -n "$SCOPE" ]] || continue
        RANGES+="dhcp-range=$SCOPE,proxy"$'\n'
    done
fi
# Nothing named means the whole interface, which is the right default for a
# lab and the wrong one for a network with workstations on it.
[[ -n "$RANGES" ]] || RANGES="dhcp-range=$INTERFACE,proxy"$'\n'

# Proxy DHCP answers alongside the real DHCP server, which means binding UDP
# 67 — and only one process on a machine can. Where the DHCP role is on this
# same machine, dnsmasq serves TFTP alone and Kea is told to advertise the
# boot files itself, which is what a DHCP server and a boot server sharing a
# host have always had to do.
KEA_CONF="/etc/kea/kea-dhcp4.conf"
SHARES_HOST_WITH_KEA="no"
if [[ -f "$KEA_CONF" ]]; then
    SHARES_HOST_WITH_KEA="yes"
    echo "==> The DHCP role is on this machine, so Kea advertises boot rather than dnsmasq"
    RANGES=""
fi

cat > /etc/dnsmasq.d/odm-pxe.conf <<DNSMASQ
# Managed by Open Directory Manager.
interface=$INTERFACE
port=0
${RANGES}enable-tftp
tftp-root=$TFTP_ROOT
DNSMASQ
if [[ "$SHARES_HOST_WITH_KEA" == "no" ]]; then
    # Proxy DHCP: address assignment stays with whatever already does it.
    cat >> /etc/dnsmasq.d/odm-pxe.conf <<DNSMASQ
pxe-service=x86PC,"Install Debian $SUITE",pxelinux
dhcp-option-force=209,odm.cfg
dhcp-option-force=210,http://$(hostname -f)/
DNSMASQ
fi

odm_enable dnsmasq

if [[ "$SHARES_HOST_WITH_KEA" == "yes" ]]; then
    odm_kea_boot_options "$TFTP_ROOT"
fi

cat <<SUMMARY

PXE role installed.

  Interface     $INTERFACE (proxy DHCP; address assignment is untouched)
  Networks      ${SCOPES:-everything on $INTERFACE}
  Boot images   $TFTP_ROOT
  Preseed       http://$(hostname -f)/odm.cfg
  Suite         $SUITE
  Mirror        $MIRROR
  Joins         $DOMAIN${JOIN_OU:+ into $JOIN_OU} with the supplied enrolment token
  Installer     $SEED_ROOT/odm-client-install (published)
$( [[ -n "$GENERATED_PASSWORD" ]] && cat <<PASSWORD

  Local administrator: $LOCAL_ADMIN / $GENERATED_PASSWORD

  This is the only time that password is shown. It is the account to use if a
  machine finishes installing but does not join.
PASSWORD
)
Boot a machine on $INTERFACE and it installs Debian $SUITE unattended, then
joins the domain on first boot.
SUMMARY
