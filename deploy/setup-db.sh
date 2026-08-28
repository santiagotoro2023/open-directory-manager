#!/usr/bin/env bash
# Create the ODM PostgreSQL role and database, write the secrets file, and
# apply migrations.
#
# PostgreSQL holds ODM's own metadata only — audit log, RBAC, recycle bin,
# role registry, GPO link cache. Directory objects always live in Samba's
# LDAP (CLAUDE.md §2).

set -euo pipefail

DB_NAME="odm"
DB_USER="odm"
SECRETS_FILE="/etc/odm/odm.env"
SERVICE_USER="odm"
VENV="/opt/odm/venv"

usage() {
    cat >&2 <<'EOF'
usage: setup-db.sh [--db <name>] [--user <name>] [--secrets-file <path>] [--venv <path>]
EOF
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --db) DB_NAME="${2:?}"; shift 2 ;;
        --user) DB_USER="${2:?}"; shift 2 ;;
        --secrets-file) SECRETS_FILE="${2:?}"; shift 2 ;;
        --venv) VENV="${2:?}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends postgresql

id -u "$SERVICE_USER" >/dev/null 2>&1 || \
    useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"

if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    echo "role $DB_USER already exists; leaving its password alone"
    DB_PASSWORD=""
else
    DB_PASSWORD="$(openssl rand -base64 32 | tr -d '\n/+=' | head -c 32)"
    sudo -u postgres psql -v ON_ERROR_STOP=1 \
        -c "CREATE ROLE \"$DB_USER\" LOGIN PASSWORD '$DB_PASSWORD'"
fi

sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
    sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"

if [[ -n "$DB_PASSWORD" ]]; then
    install -d -m 0750 -o root -g "$SERVICE_USER" "$(dirname "$SECRETS_FILE")"
    umask 077
    if [[ -f "$SECRETS_FILE" ]]; then
        sed -i "\#^ODM_DATABASE_URL=#d" "$SECRETS_FILE"
    fi
    echo "ODM_DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1/$DB_NAME" >> "$SECRETS_FILE"
    chown root:"$SERVICE_USER" "$SECRETS_FILE"
    chmod 0640 "$SECRETS_FILE"
fi

echo "==> Applying migrations"
# odm-db lives in the control plane's virtual environment, which is not on
# PATH; fall back to whatever is if the venv is somewhere else.
ODM_DB="$VENV/bin/odm-db"
[[ -x "$ODM_DB" ]] || ODM_DB="$(command -v odm-db || true)"
[[ -x "$ODM_DB" ]] || {
    echo "cannot find odm-db; install the control plane first, or pass --venv" >&2
    exit 1
}
ODM_SECRETS_FILE="$SECRETS_FILE" "$ODM_DB" migrate

cat <<EOF

Database ready.

  Database      $DB_NAME
  Role          $DB_USER
  Secrets file  $SECRETS_FILE (mode 0640, root:$SERVICE_USER — never commit it)
EOF
