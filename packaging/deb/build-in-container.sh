#!/usr/bin/env bash
# Build the odm-client package without installing anything on this machine.
#
# The desktop half needs an X11 and a Wayland toolchain, because glfw builds
# both backends on Linux. Rather than ask for those on every machine that
# builds a release, they live in a container image built here.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
VERSION="${1:-0.1.0}"
OUT="${OUT:-$REPO/dist}"
CACHE="${CACHE:-$REPO/.build-cache}"
IMAGE="odm-deb-builder"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

echo "==> Preparing the build image"
docker build -q -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE" >/dev/null

mkdir -p "$OUT" "$CACHE/go" "$CACHE/mod"

echo "==> Building"
# Run as the invoking user so nothing lands root-owned in the working tree.
docker run --rm \
    -v "$REPO:/repo:ro" \
    -v "$OUT:/out" \
    -v "$CACHE/go:/gocache" \
    -v "$CACHE/mod:/gomod" \
    -u "$(id -u):$(id -g)" \
    -e HOME=/tmp -e GOCACHE=/gocache -e GOMODCACHE=/gomod \
    -e OUT=/out -e WITH_GUI=yes \
    -w /repo "$IMAGE" \
    bash packaging/deb/build.sh "$VERSION"

echo
echo "$OUT/odm-client_${VERSION}_amd64.deb"
