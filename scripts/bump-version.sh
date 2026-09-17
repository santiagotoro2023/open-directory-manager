#!/usr/bin/env bash
# Set the release version in every file the CI version test reads — and only
# on the lines that carry it. A blanket search-and-replace once turned the
# pinned ruff==0.16.8 into ruff==0.16.9 and broke a release for it.
set -euo pipefail
NEW="${1:?usage: bump-version.sh X.Y.Z}"
cd "$(dirname "$0")/.."
OLD="$(sed -n 's/^version = "\(.*\)"/\1/p' api/pyproject.toml)"
sed -i "s/^version = \"$OLD\"/version = \"$NEW\"/" api/pyproject.toml
sed -i "s/^\(  \"version\": \)\"$OLD\"/\1\"$NEW\"/" web/package.json
sed -i "s/^const version = \"$OLD\"/const version = \"$NEW\"/" agent/main.go client-join/cmd/odm-client-install/main.go
sed -i "s/odm-client_${OLD}_amd64/odm-client_${NEW}_amd64/g; s/build-in-container.sh $OLD/build-in-container.sh $NEW/" README.md
( cd web && npm install --package-lock-only --ignore-scripts -s )
echo "$OLD -> $NEW"
