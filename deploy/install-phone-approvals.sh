#!/usr/bin/env bash
# Install phone approvals: ntfy, serving this domain's second-factor prompts.
#
# A sign-in that a policy says to approve on a phone becomes one notification
# with an Approve and a Deny button. ntfy is the open notification server and
# app that carries it (https://ntfy.sh, Apache-2.0): the phone subscribes to a
# topic of its own on this server; the control plane publishes to it; the
# buttons call the control plane back. Part of the domain controller rather
# than a role of its own, so a controller provisioned by setup.sh — or
# re-run through it — can do this without anybody installing anything else.
#
# Three things this sets up, and why:
#
# - HTTPS for the phones, on its own port, with the console's own certificate
#   and key. A self-signed one is fine: the ntfy app (1.24 and later) asks
#   once whether to trust it, pins it for that server, and skips hostname
#   checking for a pinned certificate — so the same certificate works
#   through a public address too. Plain HTTP exists on the loopback alone,
#   for the control plane on the same machine to publish through.
# - Anyone may read a topic whose name they know; only the control plane may
#   publish. The topic name is the secret (long and random, shown to the
#   person once), and publishing is what could put a fake "Approve?" in front
#   of somebody — so that needs the one token, kept beside the control
#   plane's other secrets.
# - A pinned release, verified against its published checksum, rather than a
#   third-party apt source on a domain controller. New versions arrive with
#   ODM releases, which is where their review happens.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

NTFY_VERSION="2.28.0"
# From https://github.com/binwiederhier/ntfy/releases/download/v${NTFY_VERSION}/checksums.txt
declare -A NTFY_SHA256=(
    [amd64]="48e95870ff4b1e30df8648f40e2d7f4a96956e93dc75fd07f770f726c1a4f2c5"
    [arm64]="99b840da412bf0be75e20049b74ce488acab4ffb134fd18f02d8d0622548c9fa"
)

CONSOLE_FQDN=""
SERVICE_GROUP="odm"
SECRETS_FILE="/etc/odm/odm.env"
PUBLIC_PORT="8444"
LOOPBACK_PORT="8445"
TLS_DIR="/etc/odm/tls"

usage() {
    cat >&2 <<'USAGE'
usage: install-phone-approvals.sh --console-fqdn <name> [--service-group <group>]
                                  [--secrets-file <path>] [--port <n>]

  --console-fqdn   the name on the console certificate; phones connect to it
  --service-group  the group that may read the console's key (default odm)
  --secrets-file   where the control plane's settings live
  --port           the HTTPS port phones use (default 8444)
USAGE
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --console-fqdn) CONSOLE_FQDN="${2:?}"; shift 2 ;;
        --service-group) SERVICE_GROUP="${2:?}"; shift 2 ;;
        --secrets-file) SECRETS_FILE="${2:?}"; shift 2 ;;
        --port) PUBLIC_PORT="${2:?}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done
[[ -n "$CONSOLE_FQDN" ]] || usage

ARCH="$(dpkg --print-architecture)"
[[ -n "${NTFY_SHA256[$ARCH]:-}" ]] || { echo "no ntfy build for $ARCH" >&2; exit 1; }

# ------------------------------------------------------------- package -----
installed="$(dpkg-query -W -f='${Version}' ntfy 2>/dev/null || true)"
if [[ "$installed" != "$NTFY_VERSION" ]]; then
    WORK="$(mktemp -d)"
    trap 'rm -rf "$WORK"' EXIT
    DEB="ntfy_${NTFY_VERSION}_linux_${ARCH}.deb"
    URL="https://github.com/binwiederhier/ntfy/releases/download/v${NTFY_VERSION}/${DEB}"
    curl -fsSL --retry 3 -o "$WORK/$DEB" "$URL"
    echo "${NTFY_SHA256[$ARCH]}  $WORK/$DEB" | sha256sum -c --quiet
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$WORK/$DEB" >/dev/null
fi

# ---------------------------------------------------------------- users ----
# The package creates the ntfy user. It reads the console's key through the
# service group, the same way the control plane does; the key stays 0640.
if ! id -nG ntfy | tr ' ' '\n' | grep -qx "$SERVICE_GROUP"; then
    usermod -aG "$SERVICE_GROUP" ntfy
fi

# ----------------------------------------------------------- certificate ----
# The phone server's own certificate, made once and then left alone. Phones
# pin the certificate they were shown when they subscribed, so this must not
# change when the console's does: until 0.16.3 the two were the same file,
# and replacing the console's certificate put "the fingerprint has changed"
# on every phone. The first copy is whichever certificate phones have
# already pinned — the one the console presented before its last
# replacement, where there was one — and otherwise the console's current
# certificate.
if [[ ! -s "$TLS_DIR/phone.crt" || ! -s "$TLS_DIR/phone.key" ]]; then
    SOURCE="api"
    if [[ -s "$TLS_DIR/api.crt.previous" && -s "$TLS_DIR/api.key.previous" ]]; then
        SOURCE="api"
        # Only a self-signed predecessor is one phones pinned; a certificate
        # from an authority was trusted through the authority instead.
        if [[ "$(openssl x509 -noout -issuer -in "$TLS_DIR/api.crt.previous")" == \
              "$(openssl x509 -noout -subject -in "$TLS_DIR/api.crt.previous")" ]]; then
            cp -a "$TLS_DIR/api.crt.previous" "$TLS_DIR/phone.crt"
            cp -a "$TLS_DIR/api.key.previous" "$TLS_DIR/phone.key"
            SOURCE="previous"
        fi
    fi
    if [[ "$SOURCE" == "api" ]]; then
        cp -a "$TLS_DIR/api.crt" "$TLS_DIR/phone.crt"
        cp -a "$TLS_DIR/api.key" "$TLS_DIR/phone.key"
    fi
    chown root:"$SERVICE_GROUP" "$TLS_DIR/phone.crt" "$TLS_DIR/phone.key"
    chmod 0644 "$TLS_DIR/phone.crt"
    chmod 0640 "$TLS_DIR/phone.key"
fi

# --------------------------------------------------------------- config ----
install -d -m 0755 /etc/ntfy
install -d -m 0750 -o ntfy -g ntfy /var/lib/ntfy /var/cache/ntfy
cat > /etc/ntfy/server.yml <<CONF
# Managed by Open Directory Manager (deploy/install-phone-approvals.sh).
# Local edits are overwritten the next time setup.sh runs.
base-url: "https://${CONSOLE_FQDN}:${PUBLIC_PORT}"
listen-https: ":${PUBLIC_PORT}"
listen-http: "127.0.0.1:${LOOPBACK_PORT}"
cert-file: "${TLS_DIR}/phone.crt"
key-file: "${TLS_DIR}/phone.key"
cache-file: "/var/cache/ntfy/cache.db"
cache-duration: "1h"
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "read-only"
enable-signup: false
enable-login: false
# No web page: opening a topic in a browser showed the same Confirm button the
# phone gets, and a tap there enrolled a phone that was never subscribed.
web-root: "disable"
behind-proxy: false
CONF
chown root:ntfy /etc/ntfy/server.yml
chmod 0640 /etc/ntfy/server.yml

# The server has to have run once before its user database exists — the
# CLI refuses to create the first user against a file that is not there —
# so it is started before the account is made, and the account takes
# effect without a restart.
systemctl daemon-reload
systemctl enable --now ntfy.service >/dev/null 2>&1
systemctl restart ntfy.service
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -s /var/lib/ntfy/user.db ]] && break
    sleep 1
done
[[ -s /var/lib/ntfy/user.db ]] || { echo "ntfy did not create its user database; see journalctl -u ntfy" >&2; exit 1; }

# The one account that may publish, and its token for the control plane.
# Created once; the token is kept beside the console's other secrets and put
# back into the settings file on every run, so an upgrade run of setup.sh
# that rewrote the file does not leave the control plane unable to publish.
TOKEN_FILE="/etc/ntfy/odm-token"
if [[ ! -s "$TOKEN_FILE" ]]; then
    if ! ntfy user list 2>/dev/null | grep -q '^user odm '; then
        NTFY_PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)" \
            ntfy user add --role=admin odm >/dev/null
    fi
    TOKEN="$(ntfy token add odm 2>/dev/null | sed -n 's/.*\(tk_[A-Za-z0-9_-]\{1,\}\).*/\1/p' | head -1)"
    [[ -n "$TOKEN" ]] || { echo "could not create the publishing token" >&2; exit 1; }
    (umask 077; printf '%s\n' "$TOKEN" > "$TOKEN_FILE")
fi
chown root:root "$TOKEN_FILE"
chmod 0600 "$TOKEN_FILE"

# Where a phone sends its answer: a topic named after the sign-in's token.
# Write-only for everyone — a phone can answer but nobody can read how a
# sign-in was answered — and the control plane's account, being admin, reads
# it. That keeps the whole exchange on this one port, so a port forwarded
# through a router is enough for approvals from anywhere and the console is
# never exposed for it.
ntfy access everyone 'odm-answer-*' write-only >/dev/null
chown ntfy:ntfy /var/lib/ntfy/user.db* 2>/dev/null || true

# -------------------------------------------------------------- service ----
# Restarted when the console's certificate changes hands (the console can
# replace it from Certificates), so the phones never see a stale one.
cat > /etc/systemd/system/ntfy-certificate.path <<'UNIT'
[Unit]
Description=Restart ntfy when the console certificate changes
[Path]
PathChanged=/etc/odm/tls/api.crt
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/ntfy-certificate.service <<'UNIT'
[Unit]
Description=Restart ntfy after a console certificate change
[Service]
Type=oneshot
ExecStart=/bin/systemctl restart ntfy.service
UNIT
systemctl daemon-reload
systemctl enable --now ntfy-certificate.path >/dev/null 2>&1

# ------------------------------------------------------------- settings ----
if [[ -f "$SECRETS_FILE" ]]; then
    sed -i '/^ODM_NTFY_/d; /^# --- Phone approvals/d' "$SECRETS_FILE"
    {
        printf '\n# --- Phone approvals (ntfy, from install-phone-approvals.sh) ---\n'
        printf 'ODM_NTFY_URL=http://127.0.0.1:%s\n' "$LOOPBACK_PORT"
        printf 'ODM_NTFY_PUBLIC_URL=https://%s:%s\n' "$CONSOLE_FQDN" "$PUBLIC_PORT"
        printf 'ODM_NTFY_TOKEN=%s\n' "$(cat "$TOKEN_FILE")"
    } >> "$SECRETS_FILE"
fi

# Proof it answers, on the loopback side, before saying so.
for _ in 1 2 3 4 5; do
    if curl -fsS "http://127.0.0.1:${LOOPBACK_PORT}/v1/health" >/dev/null 2>&1; then
        exit 0
    fi
    sleep 1
done
echo "ntfy did not answer on 127.0.0.1:${LOOPBACK_PORT}; see journalctl -u ntfy" >&2
exit 1
