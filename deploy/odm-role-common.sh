#!/usr/bin/env bash
# Shared by every role installer. Sourced, not executed.
#
# Installing a role on a domain controller is not the same as installing a
# package on a clean machine, and the difference is what made every role fail
# here with "Sub-process /usr/bin/dpkg returned an error code (1)":
#
#   - A package's postinst starts its service. On a controller, Samba already
#     holds port 53 and is already the Kerberos KDC, so dnsmasq, freeradius and
#     friends fail to start, the postinst fails, and dpkg reports an error for
#     a package that installed perfectly well. ODM configures these services
#     itself and starts them afterwards, so the start during unpacking is not
#     wanted in the first place.
#   - One failure leaves dpkg half-configured, and then *every* later install
#     fails for a reason that has nothing to do with the role being installed.
#
# So: recover dpkg first, hold services back while unpacking, and if apt still
# fails, print the reason rather than the summary line.

odm_apt_install() {
    export DEBIAN_FRONTEND=noninteractive

    # A machine wedged by an earlier failure fails everything until this runs,
    # and fails it with a message about the package being installed now rather
    # than the one that broke. Say so, rather than reporting unmet
    # dependencies for a package the archive has.
    if ! dpkg --configure -a >/dev/null 2>&1; then
        echo "    (a previous install left dpkg half-configured; repairing)" >&2
        apt-get --fix-broken install -y \
            -o Dpkg::Options::=--force-confold \
            -o Dpkg::Options::=--force-confdef >/dev/null 2>&1 || true
        dpkg --configure -a >/dev/null 2>&1 || \
            echo "    (dpkg is still half-configured; the install below may fail because of it)" >&2
    fi

    apt-get -o DPkg::Lock::Timeout=600 update -qq || echo "    (apt-get update failed; using the cached index)" >&2

    # 101 means "do not start". Removed again below, whatever happens, so a
    # machine is never left silently refusing to start its own services.
    local rc_d="/usr/sbin/policy-rc.d" saved=""
    if [[ -e "$rc_d" ]]; then
        saved="$rc_d.odm-saved.$$"
        mv "$rc_d" "$saved"
    fi
    printf '#!/bin/sh\nexit 101\n' > "$rc_d"
    chmod 0755 "$rc_d"

    local status=0
    apt-get install -y --no-install-recommends \
        -o Dpkg::Options::=--force-confold \
        -o Dpkg::Options::=--force-confdef \
        -o DPkg::Lock::Timeout=600 \
        "$@" || status=$?

    rm -f "$rc_d"
    [[ -n "$saved" ]] && mv "$saved" "$rc_d"

    if [[ $status -ne 0 ]]; then
        # apt's own last line says only that dpkg failed. The reason is above
        # it, and in the terminal log; an operator reading this in the console
        # should not have to go and find it on the machine.
        echo "" >&2
        echo "apt failed installing: $*" >&2
        if [[ -f /var/log/dpkg.log ]]; then
            echo "last dpkg activity:" >&2
            tail -n 15 /var/log/dpkg.log >&2
        fi
        return "$status"
    fi
    return 0
}

# Start a service ODM has just configured. Separate from installing it,
# because the install deliberately did not.
#
# A service that refuses to start says why in its journal and nowhere else.
# "kea-ctrl-agent did not start" is not something an operator can act on, so
# whatever the unit logged comes back with the failure.
odm_enable() {
    systemctl daemon-reload

    # Bounded, because "systemctl restart" waits for the job to finish and a
    # unit that never finishes starting takes the whole install with it —
    # which is what "stuck at Starting CUPS" was. A start that has not
    # happened in three minutes is a start that is not going to; whatever the
    # unit logged comes back either way.
    systemctl enable "$@" >/dev/null 2>&1 || true
    timeout 180 systemctl restart "$@" >/dev/null 2>&1 || true

    local unit failed=0
    for unit in "$@"; do
        systemctl is-active --quiet "$unit" && continue
        failed=1
        echo "" >&2
        echo "$unit did not start:" >&2
        systemctl --no-pager --lines=0 status "$unit" 2>&1 | sed 's/^/    /' >&2
        journalctl -u "$unit" --no-pager --lines=25 2>&1 | sed 's/^/    /' >&2
    done
    return "$failed"
}

# A password nothing has to remember: an internal credential ODM writes to a
# file and reads back. Drawn from /dev/urandom rather than openssl, which is
# not a dependency of every role and is missing on a minimal Debian.
#
# pipefail is turned off for the pipeline: head closes the pipe once it has
# enough, tr dies of SIGPIPE reading an endless file, and with pipefail on
# the caller would exit here having printed nothing.
odm_random_password() {
    local length="${1:-32}" value
    # stderr as well as the exit status: head closes the pipe once it has
    # enough and tr, still reading an endless file, prints "write error:
    # Broken pipe" — which the console showed as the reason the role failed.
    value="$(set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c "$length")"
    if [[ ${#value} -ne $length ]]; then
        echo "could not read $length random characters from /dev/urandom" >&2
        return 1
    fi
    printf '%s' "$value"
}

# Run a command as another account, changing nothing else.
#
# su runs the full PAM session stack, which on a domain member means pam_mount
# and pam_krb5 and a page of "HXproc_run_async: pmvarrun: No such file or
# directory" in front of whatever the command actually said.
odm_as() {
    local account="$1"; shift
    setpriv --reuid="$account" --regid="$account" --init-groups -- "$@"
}

# Tell Kea to advertise the network-boot files. Used when the DHCP role and the
# network-boot role are on the same machine: only one process can bind UDP 67,
# so dnsmasq cannot answer as a proxy DHCP server there, and the real DHCP
# server has to carry the boot options itself.
#
# Called by both installers, so whichever is installed second finds the other.
odm_kea_boot_options() {
    local conf="/etc/kea/kea-dhcp4.conf" tftp="${1:-/srv/tftp}"
    [[ -f "$conf" ]] || return 0
    [[ -e "$tftp/pxelinux.0" ]] || return 0

    # An address, not a name: next-server becomes the siaddr field of a DHCP
    # reply, which is four bytes. A machine that is still network-booting has
    # no resolver to turn a name into one either.
    local boot_server
    boot_server="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    [[ -n "$boot_server" ]] || boot_server="$(hostname -f)"

    echo "==> Adding the network-boot options to $conf (boot server $boot_server)"
    BOOT_SERVER="$boot_server" python3 - "$conf" <<'PYTHON'
import json
import os
import re
import sys

# Kea's configuration allows // comments, which json refuses.
path = sys.argv[1]
config = json.loads(re.sub(r"^\s*//.*$", "", open(path).read(), flags=re.M))
dhcp4 = config["Dhcp4"]

# Option 93 is the client's architecture. A machine booting UEFI cannot use the
# BIOS loader and the other way round, so each is told its own file.
dhcp4["next-server"] = os.environ["BOOT_SERVER"]
wanted = [
    {"name": "odm-uefi-64", "test": "option[93].hex == 0x0007",
     "boot-file-name": "debian-installer/amd64/bootnetx64.efi"},
    {"name": "odm-uefi-64-alt", "test": "option[93].hex == 0x0009",
     "boot-file-name": "debian-installer/amd64/bootnetx64.efi"},
    {"name": "odm-pxe-bios", "test": "option[93].hex == 0x0000",
     "boot-file-name": "pxelinux.0"},
]
names = {entry["name"] for entry in wanted}
kept = [c for c in dhcp4.get("client-classes", []) if c.get("name") not in names]
dhcp4["client-classes"] = kept + wanted

json.dump(config, open(path, "w"), indent=2)
PYTHON
    chmod 0640 "$conf"
    chgrp _kea "$conf" 2>/dev/null || chgrp kea "$conf" 2>/dev/null || true
    odm_enable kea-dhcp4-server
}
