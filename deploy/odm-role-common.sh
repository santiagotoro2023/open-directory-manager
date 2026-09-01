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
    systemctl enable "$@" >/dev/null 2>&1 || true
    systemctl restart "$@" >/dev/null 2>&1 || true

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
