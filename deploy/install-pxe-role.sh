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
TFTP_ROOT="/srv/tftp"
SEED_ROOT="/srv/odm-preseed"

usage() {
    cat >&2 <<'USAGE'
usage: install-pxe-role.sh --interface <iface> --domain <domain> --enrolment-token <token>
                           [--suite bookworm|trixie] [--mirror <url>]

  --interface        the network interface to serve boot requests on
  --domain           the domain installed machines join
  --enrolment-token  a multi-use token the installed machine enrols with
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
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

[[ -n "$INTERFACE" && -n "$DOMAIN" && -n "$TOKEN" ]] || usage
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
[[ "$INTERFACE" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || { echo "invalid --interface" >&2; exit 1; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || { echo "invalid --domain" >&2; exit 1; }
[[ "$SUITE" =~ ^(bookworm|trixie)$ ]] || { echo "--suite must be bookworm or trixie" >&2; exit 1; }
[[ "$TOKEN" =~ ^[A-Za-z0-9_-]{16,128}$ ]] || { echo "invalid --enrolment-token" >&2; exit 1; }
[[ "$MIRROR" =~ ^https?://[A-Za-z0-9./_-]{3,200}$ ]] || { echo "invalid --mirror" >&2; exit 1; }

echo "==> Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends dnsmasq nginx-light curl ca-certificates

echo "==> Fetching the $SUITE netboot image"
install -d -m 0755 "$TFTP_ROOT"
NETBOOT="$MIRROR/dists/$SUITE/main/installer-amd64/current/images/netboot/netboot.tar.gz"
curl -fsSL "$NETBOOT" -o /tmp/netboot.tar.gz
tar xzf /tmp/netboot.tar.gz -C "$TFTP_ROOT"
rm -f /tmp/netboot.tar.gz

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
d-i passwd/username string localadmin
d-i passwd/user-password-crypted password \$6\$odmSetMe\$changeThisOnFirstBoot

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
d-i pkgsel/include string sssd-ad sssd-tools samba-common-bin krb5-user cifs-utils libpam-mount nftables dconf-cli curl
d-i pkgsel/upgrade select full-upgrade
popularity-contest popcon/participate boolean false

d-i grub-installer/only_debian boolean true
d-i grub-installer/bootdev string default
d-i finish-install/reboot_in_progress note

# Enrol with the domain on first boot.
d-i preseed/late_command string \\
    in-target /bin/sh -c "curl -fsSL http://$(hostname -f)/odm-client-install -o /usr/sbin/odm-client-install"; \\
    in-target chmod 0755 /usr/sbin/odm-client-install; \\
    in-target /usr/sbin/odm-client-install --domain $DOMAIN --otp $TOKEN --unattended
PRESEED
chmod 0644 "$SEED_ROOT/odm.cfg"

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
cat > /etc/dnsmasq.d/odm-pxe.conf <<DNSMASQ
# Managed by Open Directory Manager.
# Proxy DHCP only: address assignment stays with whatever already does it.
interface=$INTERFACE
port=0
dhcp-range=$INTERFACE,proxy
enable-tftp
tftp-root=$TFTP_ROOT
pxe-service=x86PC,"Install Debian $SUITE",pxelinux
dhcp-option-force=209,odm.cfg
dhcp-option-force=210,http://$(hostname -f)/
DNSMASQ
systemctl enable --now dnsmasq
systemctl restart dnsmasq

cat <<SUMMARY

PXE role installed.

  Interface     $INTERFACE (proxy DHCP; address assignment is untouched)
  Boot images   $TFTP_ROOT
  Preseed       http://$(hostname -f)/odm.cfg
  Suite         $SUITE
  Joins         $DOMAIN with the supplied enrolment token

Place the odm-client-install binary at $SEED_ROOT/odm-client-install so
installed machines can fetch it.

Set a real local administrator password hash in $SEED_ROOT/odm.cfg before
using this in production; the shipped value is a placeholder.
SUMMARY
