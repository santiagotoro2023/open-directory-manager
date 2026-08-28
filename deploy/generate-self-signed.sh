#!/usr/bin/env bash
# Generate the console's first TLS certificate.
#
# ODM serves the administration console over HTTPS from the first boot. This
# creates a self-signed certificate so that is true before a certificate
# authority exists; once the certificate-authority role is installed, the
# console can re-issue its own certificate from the CA.

set -euo pipefail

FQDN="$(hostname -f 2>/dev/null || hostname)"
TLS_DIR="/etc/odm/tls"
DAYS="825"
SERVICE_GROUP="odm"

usage() {
    echo "usage: generate-self-signed.sh [--fqdn <name>] [--tls-dir <path>] [--days <n>]" >&2
    echo "                               [--service-group <name>]" >&2
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --fqdn) FQDN="${2:?}"; shift 2 ;;
        --tls-dir) TLS_DIR="${2:?}"; shift 2 ;;
        --days) DAYS="${2:?}"; shift 2 ;;
        --service-group) SERVICE_GROUP="${2:?}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
[[ "$FQDN" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || { echo "invalid --fqdn" >&2; exit 1; }
[[ "$DAYS" =~ ^[0-9]{1,5}$ ]] || { echo "invalid --days" >&2; exit 1; }

install -d -m 0750 -o root -g "$SERVICE_GROUP" "$TLS_DIR"
if [[ -f "$TLS_DIR/api.crt" ]]; then
    echo "$TLS_DIR/api.crt already exists; not overwriting" >&2
    exit 0
fi

umask 077
openssl req -x509 -newkey rsa:4096 -sha256 -days "$DAYS" -nodes \
    -keyout "$TLS_DIR/api.key" -out "$TLS_DIR/api.crt" \
    -subj "/CN=$FQDN" \
    -addext "subjectAltName=DNS:$FQDN,DNS:localhost,IP:127.0.0.1" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1

chown root:"$SERVICE_GROUP" "$TLS_DIR/api.crt" "$TLS_DIR/api.key"
chmod 0644 "$TLS_DIR/api.crt"
chmod 0640 "$TLS_DIR/api.key"

cat <<SUMMARY

Self-signed certificate created.

  Certificate  $TLS_DIR/api.crt
  Key          $TLS_DIR/api.key  (0640, root:$SERVICE_GROUP)
  Subject      CN=$FQDN, valid $DAYS days

Browsers will warn until this certificate is trusted. Install the
certificate-authority role and re-issue the console certificate from
Certificates to replace it with one the domain trusts.
SUMMARY
