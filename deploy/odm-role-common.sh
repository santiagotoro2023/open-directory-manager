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

    # A machine wedged by an earlier failure fails everything until this runs.
    dpkg --configure -a >/dev/null 2>&1 || true

    apt-get update -qq || echo "    (apt-get update failed; using the cached index)" >&2

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
odm_enable() {
    systemctl daemon-reload
    systemctl enable --now "$@"
}
