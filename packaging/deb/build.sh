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

DEPENDS="samba-common-bin, sssd-ad, sssd-tools, krb5-user, libnss-winbind, libpam-winbind, adcli"
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

sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" -e "s/@DEPENDS@/$DEPENDS/" \
    "$HERE/control.in" > "$ROOT/DEBIAN/control"
install -m 0755 "$HERE/postinst" "$ROOT/DEBIAN/postinst"
install -m 0644 "$REPO/LICENSE" "$ROOT/usr/share/doc/odm-client/copyright"
install -m 0644 "$HERE/README.deb" "$ROOT/usr/share/doc/odm-client/README"

install -d -m 0755 "$OUT"
PACKAGE="$OUT/odm-client_${VERSION}_${ARCH}.deb"
dpkg-deb --root-owner-group --build "$ROOT" "$PACKAGE" >/dev/null

echo
echo "Built $PACKAGE"
echo "  odm-client-install  command line, and what automated provisioning uses"
if [[ "$GUI_BUILT" == "yes" ]]; then
    echo "  odm-join            desktop application, in the applications menu"
else
    echo "  odm-join            not included: no desktop build toolchain here"
fi
