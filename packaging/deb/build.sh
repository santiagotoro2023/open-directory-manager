#!/usr/bin/env bash
# Build the odm-client Debian package: the domain-join tool, CLI and desktop.
#
# One file to download, open and join with. Nothing here needs the ODM
# repository afterwards, which is the point: a machine being joined has no
# reason to have a checkout on it.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
VERSION="${1:-0.1.0}"
ARCH="${ARCH:-amd64}"
OUT="${OUT:-$REPO/dist}"
# The desktop build needs X11 and OpenGL headers; a package without it is
# still useful on a server, so it is skipped rather than fatal.
WITH_GUI="${WITH_GUI:-auto}"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be x.y.z" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> Building odm-client-install"
( cd "$REPO/client-join" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" \
    go build -trimpath -ldflags "-s -w" -o "$STAGE/odm-client-install" ./cmd/odm-client-install )

# The join installs the policy agent as its last step, and a client that has
# nothing to install fails there: "Unit odm-agent.service does not exist". The
# agent and its unit belong in the package that joins the machine, along with
# the role installers a member server needs to be given a role.
echo "==> Building odm-agent"
( cd "$REPO/agent" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" \
    go build -trimpath -ldflags "-s -w" -o "$STAGE/odm-agent" . )

GUI_BUILT="no"
if [[ "$WITH_GUI" != "no" ]]; then
    echo "==> Building odm-join (desktop)"
    if ( cd "$REPO/client-join" && GOOS=linux GOARCH="$ARCH" \
            go build -tags gui -trimpath -ldflags "-s -w" \
            -o "$STAGE/odm-join" ./cmd/odm-join-gui ) 2>"$STAGE/gui.log"; then
        GUI_BUILT="yes"
    elif [[ "$WITH_GUI" == "yes" ]]; then
        echo "the desktop build failed:" >&2
        cat "$STAGE/gui.log" >&2
        exit 1
    else
        echo "    skipped: $(tail -1 "$STAGE/gui.log")" >&2
    fi
fi

ROOT="$STAGE/root"
install -d -m 0755 "$ROOT/DEBIAN" "$ROOT/usr/sbin" "$ROOT/usr/share/doc/odm-client"
install -m 0755 "$STAGE/odm-client-install" "$ROOT/usr/sbin/odm-client-install"
install -m 0755 "$STAGE/odm-agent" "$ROOT/usr/sbin/odm-agent"

install -d -m 0755 "$ROOT/lib/systemd/system" "$ROOT/usr/lib/odm/roles"
install -m 0644 "$REPO/deploy/odm-agent.service" "$ROOT/lib/systemd/system/odm-agent.service"
# A member server is given a role by its own agent running one of these.
install -m 0755 "$REPO"/deploy/install-*-role.sh "$ROOT/usr/lib/odm/roles/"
install -m 0644 "$REPO/deploy/odm-role-common.sh" "$ROOT/usr/lib/odm/roles/"
install -m 0755 "$REPO/deploy/odm-apply-console-certificate" "$ROOT/usr/lib/odm/roles/"

# cifs-utils and keyutils are what a drive map and a roaming profile are made
# of. Without keyutils there is no request-key, so the kernel cannot ask for a
# Kerberos ticket for the mount and every one of them fails with
# "Send error in SessSetup = -2" — an error that names neither Kerberos nor
# the missing package.
# No winbind. SSSD is the client's identity and authentication provider, and
# Debian's PAM stack runs pam_winbind before pam_sss with each success jumping
# over the rest: with both installed, winbind answered the login, asked the
# domain for no Kerberos ticket, and SSSD — which was configured to write one —
# never saw it. Every drive map then failed with "Required key not available"
# on a machine where everything else worked.
DEPENDS="samba-common-bin, sssd-ad, sssd-tools, krb5-user, adcli"
DEPENDS="$DEPENDS, cifs-utils, keyutils"
# smbclient reads the console's certificate out of SYSVOL during the join, so
# nothing has to be carried to the machine by hand. Without it a join has no
# way to give the agent a trust anchor and says so.
DEPENDS="$DEPENDS, smbclient"
if [[ "$GUI_BUILT" == "yes" ]]; then
    install -d -m 0755 "$ROOT/usr/bin" \
        "$ROOT/usr/share/applications" \
        "$ROOT/usr/share/icons/hicolor/scalable/apps"
    install -m 0755 "$STAGE/odm-join" "$ROOT/usr/bin/odm-join"
    # The mark alone is only ever an application icon; the window and the
    # welcome screen carry the name as text (branding/BRAND.md).
    install -m 0644 "$REPO/branding/odm-mark.svg" \
        "$ROOT/usr/share/icons/hicolor/scalable/apps/odm-join.svg"
    install -m 0644 "$HERE/odm-join.desktop" "$ROOT/usr/share/applications/odm-join.desktop"
    DEPENDS="$DEPENDS, policykit-1 | polkitd, libgl1"
fi

# The libraries the binaries actually need, read out of the binaries rather
# than listed by hand. A desktop build links against whatever the toolchain
# gave it, and a hand-written list is a list that goes stale silently — the
# first version of this package shipped without libwayland-client0 and the
# desktop app would not have started.
if command -v dpkg-shlibdeps >/dev/null 2>&1; then
    SHLIBS_DIR="$STAGE/shlibs"
    mkdir -p "$SHLIBS_DIR/debian"
    printf 'Source: odm-client\nPackage: odm-client\nArchitecture: %s\n' "$ARCH" \
        > "$SHLIBS_DIR/debian/control"
    BINARIES=("$ROOT/usr/sbin/odm-client-install")
    [[ "$GUI_BUILT" == "yes" ]] && BINARIES+=("$ROOT/usr/bin/odm-join")
    if SHLIBS="$(cd "$SHLIBS_DIR" && dpkg-shlibdeps -O --ignore-missing-info \
            "${BINARIES[@]}" 2>/dev/null)"; then
        SHLIBS="${SHLIBS#shlibs:Depends=}"
        [[ -n "$SHLIBS" ]] && DEPENDS="$DEPENDS, $SHLIBS"
    else
        echo "    note: dpkg-shlibdeps found nothing; library dependencies not added" >&2
    fi
fi

# Substituted in bash rather than with sed: a dependency list contains "|"
# for alternatives, and every sed delimiter is a character some value can hold.
CONTROL="$(cat "$HERE/control.in")"
CONTROL="${CONTROL//@VERSION@/$VERSION}"
CONTROL="${CONTROL//@ARCH@/$ARCH}"
CONTROL="${CONTROL//@DEPENDS@/$DEPENDS}"
printf '%s\n' "$CONTROL" > "$ROOT/DEBIAN/control"
install -m 0755 "$HERE/postinst" "$ROOT/DEBIAN/postinst"
install -m 0755 "$HERE/prerm" "$ROOT/DEBIAN/prerm"
install -m 0644 "$REPO/LICENSE" "$ROOT/usr/share/doc/odm-client/copyright"
install -m 0644 "$HERE/README.deb" "$ROOT/usr/share/doc/odm-client/README"

install -d -m 0755 "$OUT"
PACKAGE="$OUT/odm-client_${VERSION}_${ARCH}.deb"
dpkg-deb --root-owner-group --build "$ROOT" "$PACKAGE" >/dev/null

echo
echo "Built $PACKAGE"
echo "  odm-client-install  command line, and what automated provisioning uses"
echo "  odm-agent           applies policy and reports it back, once joined"
if [[ "$GUI_BUILT" == "yes" ]]; then
    echo "  odm-join            desktop application, in the applications menu"
else
    echo "  odm-join            not included: no desktop build toolchain here"
fi
