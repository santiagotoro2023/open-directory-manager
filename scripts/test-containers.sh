#!/usr/bin/env bash
# End-to-end test of the container images (docs/CONTAINERS.md): a whole
# domain from docker-compose.yml on this machine, then the things that prove
# it is one — signing in as a domain administrator, the directory, DNS
# through samba-tool, the controller's own agent checking in, a domain
# backup written by that agent to the shared volume, phone approvals.
#
#   scripts/test-containers.sh [--keep]
#
# Uses the images already tagged ghcr.io/<owner>/open-directory-manager:latest
# and ...-node:latest (build them first). Needs a disposable machine: the
# controller takes this host's DNS, Kerberos, LDAP and SMB ports.
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP="no"
[[ "${1:-}" == "--keep" ]] && KEEP="yes"

WORK="$(mktemp -d)"
ADDRESS="${ODM_TEST_ADDRESS:-$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')}"
PASSWORD="Odm-Test-$(head -c 9 /dev/urandom | base64 | tr -d '/+=')9a"
cat > "$WORK/env" <<ENV
ODM_REALM=CORP.EXAMPLE.INTERNAL
ODM_DOMAIN=corp.example.internal
ODM_HOST_ADDRESS=$ADDRESS
ODM_ADMIN_PASSWORD=$PASSWORD
POSTGRES_PASSWORD=test-$(head -c 9 /dev/urandom | base64 | tr -d '/+=')
ODM_DNS_FORWARDER=9.9.9.9
ENV
COMPOSE=(docker compose -p odm-test --env-file "$WORK/env")

cleanup() {
    if [[ "$KEEP" != "yes" ]]; then
        "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
        rm -rf "$WORK"
    fi
}
trap cleanup EXIT
fail() {
    echo "FAIL: $*" >&2
    "${COMPOSE[@]}" logs --tail 80 >&2 || true
    exit 1
}
step() { printf '\n== %s\n' "$*"; }

step "starting the domain on $ADDRESS"
"${COMPOSE[@]}" up -d --pull never

URL="https://odm.corp.example.internal:8443"
CURL=(curl -sk --noproxy '*' --resolve "odm.corp.example.internal:8443:127.0.0.1"
      -b "$WORK/jar" -c "$WORK/jar" -H "Origin: $URL")

step "waiting for the controller to provision and the console to start"
for _ in $(seq 1 120); do
    "${CURL[@]}" -fs "$URL/api/v1/healthz" >/dev/null 2>&1 && break
    sleep 5
done
"${CURL[@]}" -fs "$URL/api/v1/healthz" || fail "the console never answered"

step "signing in as the domain Administrator"
LOGIN="$("${CURL[@]}" -fs -H 'Content-Type: application/json' \
    -d "{\"username\":\"Administrator\",\"password\":\"$PASSWORD\"}" "$URL/api/v1/auth/login")" ||
    fail "sign-in refused"
CSRF="$(printf '%s' "$LOGIN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf_token"])')"
api() { "${CURL[@]}" -fs -H "X-ODM-CSRF: $CSRF" "$@"; }

step "the directory"
api "$URL/api/v1/directory/objects?container=CN=Users,DC=corp,DC=example,DC=internal" |
    grep -q '"sAMAccountName":"Administrator"' || fail "no Administrator in CN=Users"

step "DNS through samba-tool, from the control plane's container"
api "$URL/api/v1/dns/zones" | grep -q '"name":"corp.example.internal"' || fail "no domain zone"

step "the controller's agent checks in"
for _ in $(seq 1 60); do
    docker exec odm-test-dc1-1 odm-agent check 2>/dev/null | grep -q "has checked in" && break
    sleep 5
done
docker exec odm-test-dc1-1 odm-agent check | tail -3
docker exec odm-test-dc1-1 odm-agent check | grep -q "has checked in" || fail "the agent did not check in"

step "a domain backup, taken by the controller's agent onto the shared volume"
api -X POST "$URL/api/v1/backups" >/dev/null || fail "backup refused"
for _ in $(seq 1 60); do
    api "$URL/api/v1/backups" | grep -q '"archives":\[{' && break
    sleep 5
done
api "$URL/api/v1/backups" | grep -q '"archives":\[{' || fail "no backup archive appeared"

step "phone approvals: the notification server is up and has its token"
docker exec odm-test-ntfy-1 curl -fsS http://127.0.0.1:8445/v1/health | grep -q true ||
    fail "ntfy is not healthy"
docker exec odm-test-odm-1 test -s /srv/odm-data/secrets/ntfy-token || fail "no ntfy token"

printf '\nAll container checks passed.\n'
