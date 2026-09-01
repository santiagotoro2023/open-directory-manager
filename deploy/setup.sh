#!/usr/bin/env bash
# Guided setup for Open Directory Manager.
#
# Takes a fresh Debian server to a working domain with the console running,
# asking for what it cannot work out and explaining each step as it goes.
#
# Run as root. This reconfigures Samba, DNS and networking on the machine it
# runs on — use a dedicated server or virtual machine.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

REALM=""
NETBIOS=""
FORWARDER=""
CONSOLE_FQDN=""
ADMIN_PASSWORD=""
ADMIN_GROUP="Domain Admins"
PORT="8443"
VENV="/opt/odm/venv"
CONSOLE_DIR="/opt/odm/console"
SECRETS_FILE="/etc/odm/odm.env"
SERVICE_USER="odm"
SKIP_DC="no"
SKIP_CONSOLE="no"
ASSUME_YES="no"

STEP=0
STEPS=9
CURRENT="starting up"

usage() {
    cat >&2 <<'USAGE'
usage: setup.sh [options]

Sets up a domain and the ODM console on this machine. Anything not given on
the command line is asked for.

  --realm <dns.domain>     domain to create, e.g. corp.example.internal
  --netbios <SHORTNAME>    NetBIOS domain name, e.g. EXAMPLE
  --forwarder <ip>         upstream resolver for non-domain queries
  --console-fqdn <name>    the name operators reach the console at
  --admin-group <name>     group whose members may sign in (default: Domain Admins)
  --port <n>               console and API port (default: 8443)
  --skip-dc                this machine is not the domain controller
  --skip-console           do not build the console here
  --service-user <name>    account the control plane runs as (default: odm)
  --yes                    accept the summary without pausing
USAGE
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --realm) REALM="${2:?}"; shift 2 ;;
        --netbios) NETBIOS="${2:?}"; shift 2 ;;
        --forwarder) FORWARDER="${2:?}"; shift 2 ;;
        --console-fqdn) CONSOLE_FQDN="${2:?}"; shift 2 ;;
        --admin-group) ADMIN_GROUP="${2:?}"; shift 2 ;;
        --port) PORT="${2:?}"; shift 2 ;;
        --skip-dc) SKIP_DC="yes"; shift ;;
        --skip-console) SKIP_CONSOLE="yes"; shift ;;
        --service-user) SERVICE_USER="${2:?}"; shift 2 ;;
        --yes) ASSUME_YES="yes"; shift ;;
        -h|--help) usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

# ------------------------------------------------------------------ output --

if [[ -t 1 ]]; then
    B=$'\033[1m'; DIM=$'\033[2m'; BLUE=$'\033[1;34m'; GREEN=$'\033[1;32m'
    YELLOW=$'\033[33m'; RED=$'\033[31m'; R=$'\033[0m'
else
    B=""; DIM=""; BLUE=""; GREEN=""; YELLOW=""; RED=""; R=""
fi

step()  { STEP=$((STEP + 1)); CURRENT="$1"; printf '\n%s[%d/%d]%s %s%s%s\n' "$BLUE" "$STEP" "$STEPS" "$R" "$B" "$1" "$R"; }
info()  { printf '      %s\n' "$*"; }
note()  { printf '      %s%s%s\n' "$DIM" "$*" "$R"; }
warn()  { printf '      %s%s%s\n' "$YELLOW" "$*" "$R" >&2; }
ok()    { printf '      %s✓%s %s\n' "$GREEN" "$R" "$*"; }
fail()  { printf '\n%sSetup stopped: %s%s\n' "$RED" "$*" "$R" >&2; exit 1; }

on_error() {
    printf '\n%sSetup failed during: %s%s\n' "$RED" "$CURRENT" "$R" >&2
    printf '%sNothing after this point ran. Fix the problem and run setup again;%s\n' "$DIM" "$R" >&2
    printf '%ssteps that already completed are skipped on a second run.%s\n' "$DIM" "$R" >&2
    # It says nothing after this point ran, so nothing after this point runs.
    # Without this the message appeared and setup carried on, printing it
    # again at every later hiccup.
    exit 1
}
trap on_error ERR

ask() {
    local prompt="$1" default="${2:-}" answer
    # No terminal means a scripted install. Reading would get end-of-file
    # straight away and loop on the complaint for ever, which is what
    # happened when setup was driven from a pipe.
    if [[ ! -t 0 ]]; then
        [[ -n "$default" ]] || fail "$prompt has no answer and there is no terminal to ask at"
        printf '%s' "$default"
        info "$prompt: $default (no terminal; taking the default)" >&2
        return
    fi
    if [[ -n "$default" ]]; then
        read -rp "      $prompt [$default]: " answer
        printf '%s' "${answer:-$default}"
    else
        read -rp "      $prompt: " answer
        printf '%s' "$answer"
    fi
}

# Asks until the answer matches, so a typo does not end the run.
ask_until() {
    local prompt="$1" default="$2" pattern="$3" complaint="$4" answer
    while true; do
        answer="$(ask "$prompt" "$default")"
        # if/then rather than [[ ]] && {}: a test that is meant to fail is
        # not an error, and as a bare statement it tripped the ERR trap.
        if [[ "$answer" =~ $pattern ]]; then
            printf '%s' "$answer"
            return
        fi
        warn "$complaint"
    done
}

ask_yes_no() {
    local prompt="$1" default="${2:-no}" answer
    if [[ "$ASSUME_YES" == "yes" ]]; then
        printf 'yes'
        return
    fi
    while true; do
        answer="$(ask "$prompt (yes/no)" "$default")"
        case "${answer,,}" in
            y|yes) printf 'yes'; return ;;
            n|no)  printf 'no'; return ;;
            *) warn "Answer yes or no." ;;
        esac
    done
}

ask_secret() {
    # Everything except the secret itself goes to stderr. The caller reads this
    # through a command substitution, which captures stdout: a bare echo for
    # the newline after a silent read ends up *inside* the password, and the
    # account is then created with a password nobody can type.
    local prompt="$1" first second
    # Set by an unattended install. Never defaulted and never echoed.
    if [[ -n "${ODM_ADMIN_PASSWORD:-}" ]]; then
        printf '%s' "$ODM_ADMIN_PASSWORD"
        return
    fi
    [[ -t 0 ]] || fail "no terminal to ask for a password at; set ODM_ADMIN_PASSWORD"
    while true; do
        read -rsp "      $prompt: " first; echo >&2
        [[ ${#first} -ge 8 ]] || { warn "Use at least 8 characters."; continue; }
        read -rsp "      Repeat it: " second; echo >&2
        [[ "$first" == "$second" ]] || { warn "They do not match. Try again."; continue; }
        printf '%s' "$first"
        return
    done
}

# ---------------------------------------------------------------- hostname --

set_hostname() {
    local fqdn="$1" short="${1%%.*}" address resolved
    address="$(hostname -I 2>/dev/null | awk '{print $1}')"

    hostnamectl set-hostname "$fqdn"

    # Debian ships a 127.0.1.1 line for the short name. A domain controller
    # needs its real address to resolve to the fully-qualified name instead.
    cp -a /etc/hosts "/etc/hosts.pre-odm.$(date +%s)"
    sed -i '/^127\.0\.1\.1[[:space:]]/d' /etc/hosts
    if [[ -n "$address" ]]; then
        sed -i "/[[:space:]]$fqdn\([[:space:]]\|$\)/d" /etc/hosts
        printf '%s\t%s %s\n' "$address" "$fqdn" "$short" >> /etc/hosts
        ok "$address now resolves to $fqdn"
    else
        warn "No address found on this machine; add $fqdn to /etc/hosts yourself."
    fi

    systemctl restart systemd-hostnamed >/dev/null 2>&1 || true
    systemctl try-restart rsyslog >/dev/null 2>&1 || true

    resolved="$(hostname -f 2>/dev/null || true)"
    if [[ "$resolved" == "$fqdn" ]]; then
        ok "This machine is now $fqdn"
    else
        warn "hostname -f still reports \"$resolved\" rather than \"$fqdn\"."
        warn "The domain will not provision until that is fixed in /etc/hosts."
        [[ "$(ask_yes_no "Continue anyway?" "no")" == "yes" ]] ||
            fail "fix /etc/hosts and run setup again"
    fi
}

# ---------------------------------------------------------------- welcome --

clear 2>/dev/null || true
cat <<BANNER
${B}Open Directory Manager — setup${R}

  This sets up an Active Directory domain on this machine and starts the
  administration console. It will:

    1. check this machine is ready
    2. ask what the domain should be called
    3. provision the domain controller
    4. create the control plane's own account
    5. install the control plane
    6. set up TLS and the database
    7. build the console
    8. start everything and tell you where to sign in
    9. install the policy agent on this controller

  ${YELLOW}This reconfigures Samba, DNS and networking here. Use a dedicated
  server or virtual machine.${R}

BANNER

[[ $EUID -eq 0 ]] || fail "run this as root: sudo deploy/setup.sh"
[[ -d "$REPO/api" && -d "$REPO/web" ]] || fail "run this from inside a checkout of the repository"

# ---------------------------------------------------------------- step 1 --

step "Checking this machine"

if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    info "Operating system: ${PRETTY_NAME:-unknown}"
    case "${VERSION_CODENAME:-}" in
        bookworm|trixie) ok "Supported release" ;;
        *) warn "ODM targets Debian 12 and 13. Continuing, but this is untested." ;;
    esac
fi

HOSTNAME_FQDN="$(hostname -f 2>/dev/null || hostname)"
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname)"
info "Machine name: $HOSTNAME_FQDN"
info "Address: $(hostname -I 2>/dev/null | awk '{print $1}' || echo unknown)"

if [[ -f /var/lib/samba/private/sam.ldb ]]; then
    note "A domain already exists here; provisioning will be skipped."
fi

command -v systemctl >/dev/null || fail "this needs systemd"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
    info "Created the $SERVICE_USER service account"
elif [[ "$(id -u "$SERVICE_USER")" -ge 1000 ]]; then
    # An account someone logs in with is not a service account. The control
    # plane would run as them, and its keytab and database password are
    # readable by its group.
    warn "$SERVICE_USER is a login account, not a service account."
    warn "The control plane would run as $SERVICE_USER and share its group."
    warn "Run with --service-user <name> to keep the two separate."
    if [[ "$(ask_yes_no "Continue using $SERVICE_USER anyway?" "yes")" != "yes" ]]; then
        fail "re-run with --service-user <name>"
    fi
fi
ok "Ready to continue"

# ---------------------------------------------------------------- step 2 --

step "Naming the domain"

if [[ -z "$REALM" ]]; then
    note "The domain name is what machines and users belong to, for example"
    note "corp.example.internal. Use a name you control, not a public one you"
    note "do not."
    DEFAULT_REALM=""
    [[ "$HOSTNAME_FQDN" == *.* ]] && DEFAULT_REALM="${HOSTNAME_FQDN#*.}"
    REALM="$(ask_until "Domain name" "${DEFAULT_REALM:-corp.example.internal}" \
        '^[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$' "That is not a domain name, e.g. corp.example.internal")"
fi
REALM="${REALM,,}"
REALM_UPPER="${REALM^^}"
ok "Domain: $REALM"

# A machine with only a short name needs a fully-qualified one: it becomes
# this controller's identity in the directory and on its certificate.
if [[ "$HOSTNAME_FQDN" != *.* ]]; then
    echo
    info "This machine is called \"$HOSTNAME_FQDN\" and has no domain part yet."
    # --console-fqdn has already named this machine when it names this
    # machine, so do not ask the same question twice.
    if [[ "${CONSOLE_FQDN%%.*}" == "$HOSTNAME_SHORT" ]]; then
        set_hostname "${CONSOLE_FQDN,,}"
        HOSTNAME_FQDN="${CONSOLE_FQDN,,}"
        HOSTNAME_SHORT="${HOSTNAME_FQDN%%.*}"
    else
    NEW_HOSTNAME="$(ask_until "Full name for this machine" "$HOSTNAME_SHORT.$REALM" \
        '^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$' "Include the domain, e.g. $HOSTNAME_SHORT.$REALM")"
    set_hostname "${NEW_HOSTNAME,,}"
    HOSTNAME_FQDN="${NEW_HOSTNAME,,}"
    HOSTNAME_SHORT="${HOSTNAME_FQDN%%.*}"
    fi
fi

if [[ "$SKIP_DC" == "no" && ! -f /var/lib/samba/private/sam.ldb ]]; then
    [[ -n "$NETBIOS" ]] || {
        note "The NetBIOS name is the domain's short name, used by older tools."
        NETBIOS="$(ask_until "NetBIOS name" \
            "$(printf '%s' "${REALM%%.*}" | tr '[:lower:]' '[:upper:]' | cut -c1-15)" \
            '^[A-Z0-9-]{1,15}$' "Up to 15 characters, upper case, letters digits and dashes")"
    }
    [[ -n "$FORWARDER" ]] || {
        note "Queries for names outside the domain are passed to this resolver."
        FORWARDER="$(ask_until "Upstream DNS forwarder" "9.9.9.9" \
            '^[0-9a-fA-F.:]+$' "That is not an IP address")"
    }
fi

[[ -n "$CONSOLE_FQDN" ]] || {
    note "The console is served over HTTPS at this name."
    CONSOLE_FQDN="$(ask_until "Console address" "$HOSTNAME_FQDN" \
        '^[A-Za-z0-9.-]{1,253}$' "That is not a host name")"
}
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || fail "invalid port: $PORT"

if [[ "$SKIP_DC" == "no" && ! -f /var/lib/samba/private/sam.ldb ]]; then
    echo
    note "This password belongs to the domain's Administrator account. It is"
    note "what you will sign in to the console with."
    ADMIN_PASSWORD="$(ask_secret "Domain administrator password")"
fi

cat <<SUMMARY

  ${B}About to set up${R}

    This machine       $HOSTNAME_FQDN
    Domain             $REALM
    Kerberos realm     $REALM_UPPER
    NetBIOS name       ${NETBIOS:-(existing domain)}
    DNS forwarder      ${FORWARDER:-(unchanged)}
    Console            https://$CONSOLE_FQDN:$PORT/
    Sign-in group      $ADMIN_GROUP
    Domain controller  $([[ "$SKIP_DC" == "yes" ]] && echo "elsewhere" || echo "this machine")
    Console build      $([[ "$SKIP_CONSOLE" == "yes" ]] && echo "skipped" || echo "$CONSOLE_DIR")

SUMMARY

[[ "$(ask_yes_no "Go ahead?" "yes")" == "yes" ]] || fail "nothing was changed"

# ---------------------------------------------------------------- step 3 --

step "Provisioning the domain controller"

if [[ "$SKIP_DC" == "yes" ]]; then
    info "Skipped: the controller is elsewhere."
elif [[ -f /var/lib/samba/private/sam.ldb ]]; then
    ok "Already provisioned"
    # Provisioning is also what starts the directory and its DNS. Skipping it
    # on a re-run must not leave them stopped: every client finds this machine
    # by asking it for its own address.
    systemctl enable --now samba-ad-dc >/dev/null 2>&1 || true
else
    info "This takes a couple of minutes."
    ODM_ADMIN_PASSWORD="$ADMIN_PASSWORD" "$HERE/provision-dc.sh" \
        --realm "$REALM" --netbios "$NETBIOS" ${FORWARDER:+--forwarder "$FORWARDER"}
    ok "Domain $REALM is up"
fi

if [[ "$SKIP_DC" != "yes" ]] &&
        ! grep -q "ldap server require strong auth" /etc/samba/smb.conf 2>/dev/null; then
    # ldap3 authenticates with GSSAPI but implements no SASL security layer, and
    # Samba's default "require strong auth = yes" refuses a SASL bind that brings
    # none — even inside LDAPS. Accepting it over TLS is what this value is for:
    # the transport still encrypts everything the SASL layer would have.
    sed -i "/^\[global\]/a\\        ldap server require strong auth = allow_sasl_over_tls" \
        /etc/samba/smb.conf
    systemctl restart samba-ad-dc
    ok "The directory accepts the control plane's bind"
fi

# ---------------------------------------------------------------- step 4 --

step "Creating the control plane's account"

if [[ "$SKIP_DC" == "yes" ]]; then
    warn "Run create-api-service-account.sh on a domain controller and copy"
    warn "the keytab to /etc/odm/odm-api.keytab before starting the service."
else
    "$HERE/create-api-service-account.sh" --realm "$REALM" --api-host "$CONSOLE_FQDN" \
        --service-user "$SERVICE_USER"
    ok "svc-odm-api created, with a keytab at /etc/odm/odm-api.keytab"
fi

# ---------------------------------------------------------------- step 5 --

step "Installing the control plane"

export DEBIAN_FRONTEND=noninteractive
info "Installing build dependencies"
apt-get install -y --no-install-recommends \
    python3-venv python3-dev build-essential libkrb5-dev libsasl2-dev curl >/dev/null

install -d -m 0755 /opt/odm
[[ -x "$VENV/bin/python" ]] || python3 -m venv "$VENV"
info "Installing the control plane (this takes a minute)"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet "$REPO/api"
ok "Installed into $VENV"

install -d -m 0750 -o root -g "$SERVICE_USER" /etc/odm
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/lib/odm
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/backups/odm

# Samba's own CA lives under a root-only directory; create-api-service-account.sh
# publishes a readable copy.
LDAP_CA="/etc/odm/tls/dc-ca.pem"
if [[ ! -f "$LDAP_CA" && -f /var/lib/samba/private/tls/ca.pem ]]; then
    install -d -m 0755 /etc/odm/tls
    install -m 0644 /var/lib/samba/private/tls/ca.pem "$LDAP_CA"
fi

# Scoped deliberately: the secrets file must never exist world-readable, even
# for an instant. Left set, it would also strip the read bits off everything
# written below, including the console the service has to serve.
umask 077
cat > "$SECRETS_FILE" <<ENVFILE
# Written by deploy/setup.sh. Settings and secrets live here and nowhere else.
# Mode 0640, root:$SERVICE_USER. Never commit this file.

# --- Domain ---
ODM_REALM=$REALM_UPPER
ODM_DOMAIN=$REALM
ODM_ADMIN_GROUP=$ADMIN_GROUP

# --- LDAP (LDAPS only) ---
ODM_LDAP_URI=ldaps://$HOSTNAME_FQDN
ODM_LDAP_CA_CERT=$LDAP_CA

# --- Kerberos ---
ODM_KEYTAB=/etc/odm/odm-api.keytab

# --- Group Policy ---
ODM_AGENT_REFRESH_MINUTES=15
# Mirrors policy objects into LDAP and SYSVOL so GPMC and RSAT see them.
# Off by default: it needs the $SERVICE_USER user to write Samba's SYSVOL
# share, and ReadWritePaths in the unit file extended to match.
#ODM_SYSVOL_PATH=/var/lib/samba/sysvol/$REALM/Policies

# --- Console ---
ODM_CONSOLE_DIR=$CONSOLE_DIR
ODM_ALLOWED_ORIGINS=["https://$CONSOLE_FQDN:$PORT"]

# --- Sessions ---
ODM_SESSION_TTL_MINUTES=480
ODM_SESSION_IDLE_MINUTES=60
ODM_LOGIN_MAX_FAILURES=5
ODM_LOGIN_LOCKOUT_MINUTES=15
ODM_ADMIN_RECHECK_MINUTES=5

# --- Backups ---
ODM_BACKUP_DIR=/var/backups/odm
ODM_BACKUP_INTERVAL_HOURS=24
ODM_BACKUP_KEEP=14

# --- Recycle bin ---
ODM_RETENTION_DAYS=180

# The database URL is appended below by setup-db.sh.
ENVFILE
umask 022
chown root:"$SERVICE_USER" "$SECRETS_FILE"
chmod 0640 "$SECRETS_FILE"
umask 022
ok "Settings written to $SECRETS_FILE"

# ---------------------------------------------------------------- step 6 --

step "Setting up TLS and the database"

"$HERE/generate-self-signed.sh" --fqdn "$CONSOLE_FQDN" \
    --service-group "$SERVICE_USER" >/dev/null
ok "Console certificate created (self-signed for now)"

"$HERE/setup-db.sh" --secrets-file "$SECRETS_FILE" --venv "$VENV" \
    --service-user "$SERVICE_USER" >/dev/null
ok "PostgreSQL database created and migrated"

# ---------------------------------------------------------------- step 7 --

step "Building the console"

if [[ "$SKIP_CONSOLE" == "yes" ]]; then
    info "Skipped."
    sed -i "s#^ODM_CONSOLE_DIR=#\# ODM_CONSOLE_DIR=#" "$SECRETS_FILE"
else
    command -v npm >/dev/null 2>&1 || {
        info "Installing Node"
        apt-get install -y --no-install-recommends nodejs npm >/dev/null
    }
    info "Compiling (this takes a minute)"
    if (cd "$REPO/web" && npm install --no-audit --no-fund >/dev/null 2>&1 \
            && npm run build >/dev/null 2>&1); then
        rm -rf "$CONSOLE_DIR"
        install -d -m 0755 "$CONSOLE_DIR"
        cp -r "$REPO/web/dist/." "$CONSOLE_DIR/"
        # The service runs as $SERVICE_USER and has to read every file here.
        chmod -R u=rwX,go=rX "$CONSOLE_DIR"
        if runuser -u "$SERVICE_USER" -- test -r "$CONSOLE_DIR/index.html"; then
            ok "Console installed to $CONSOLE_DIR"
        else
            warn "The $SERVICE_USER user cannot read $CONSOLE_DIR/index.html."
            warn "The console will not load until it can."
        fi
    else
        warn "The console did not build here, so the API will serve the API only."
        warn "Build it on another machine, copy dist/ to $CONSOLE_DIR, uncomment"
        warn "ODM_CONSOLE_DIR in $SECRETS_FILE and restart odm-api."
        sed -i "s#^ODM_CONSOLE_DIR=#\# ODM_CONSOLE_DIR=#" "$SECRETS_FILE"
    fi
fi

ok "Console step complete"

# ---------------------------------------------------------------- step 8 --

step "Starting Open Directory Manager"

# Four scripts write under /etc/odm and the service has to read all of it, so
# ownership is settled here once rather than in each of them. The checks below
# then confirm it on the files that stop the service dead if it is wrong.
chown -R "root:$SERVICE_USER" /etc/odm
find /etc/odm -type d -exec chmod 0750 {} +
find /etc/odm -type f -exec chmod 0640 {} +

if [[ -f /etc/odm/odm-api.keytab ]]; then
    if runuser -u "$SERVICE_USER" -- test -r /etc/odm/odm-api.keytab; then
        ok "The service can read its keytab"
    else
        warn "The $SERVICE_USER user cannot read /etc/odm/odm-api.keytab."
        warn "Kerberos authentication will fail until it can."
    fi
else
    warn "No keytab at /etc/odm/odm-api.keytab; Kerberos features will not work."
fi

if runuser -u "$SERVICE_USER" -- test -r "$LDAP_CA" 2>/dev/null; then
    ok "The service can read the directory CA"
else
    warn "The $SERVICE_USER user cannot read $LDAP_CA; LDAPS will fail."
fi

# uvicorn loads these before it binds a port, so an unreadable key is not a
# degraded console: it is no console at all.
for FILE in /etc/odm/tls/api.crt /etc/odm/tls/api.key; do
    if runuser -u "$SERVICE_USER" -- test -r "$FILE"; then
        continue
    fi
    warn "The $SERVICE_USER user cannot read $FILE."
    fail "the console certificate must be readable by $SERVICE_USER"
done
ok "The service can read its console certificate"

install -m 0644 "$HERE/odm-api.service" /etc/systemd/system/odm-api.service
[[ "$PORT" == "8443" ]] || sed -i "s#--port 8443#--port $PORT#" /etc/systemd/system/odm-api.service
if [[ "$SERVICE_USER" != "odm" ]]; then
    sed -i "s#^User=odm\$#User=$SERVICE_USER#;s#^Group=odm\$#Group=$SERVICE_USER#" \
        /etc/systemd/system/odm-api.service
fi
systemctl daemon-reload
systemctl enable odm-api >/dev/null 2>&1 || true
systemctl restart odm-api || true

READY="no"
for _ in $(seq 1 30); do
    if curl -fsSk "https://127.0.0.1:$PORT/api/v1/healthz" >/dev/null 2>&1; then
        READY="yes"
        break
    fi
    sleep 2
done

# ---------------------------------------------------------------- step 9 --

step "Installing the policy agent on this controller"

# The controller is a managed machine like any other, and until it runs the
# agent the console can see it but do nothing with it: no roles installed on
# it, no inventory, no re-issued console certificate. Installing a role means
# apt and service restarts, which the control plane cannot do even to its own
# host — it runs under ProtectSystem=strict with NoNewPrivileges, which is
# what an identity system should look like. The agent is what does that work,
# here exactly as on every other server.
# A Samba controller keeps its keys in its own database and never writes
# /etc/krb5.keytab, so the agent — which authenticates as this machine's
# computer account, exactly as it does on a member server — has nothing to
# load. Export that one principal, and only it.
if [[ ! -f /etc/krb5.keytab ]]; then
    MACHINE_PRINCIPAL="$(hostname -s | tr '[:lower:]' '[:upper:]')\$"
    if samba-tool domain exportkeytab /etc/krb5.keytab \
            --principal="$MACHINE_PRINCIPAL" >/dev/null 2>&1; then
        chmod 0600 /etc/krb5.keytab
        ok "Exported this controller's machine keytab"
    else
        warn "Could not export a machine keytab for $MACHINE_PRINCIPAL."
    fi
fi

AGENT_BINARY="$REPO/agent/odm-agent"
AGENT_LOG="/var/log/odm-agent-install.log"

if [[ ! -x "$AGENT_BINARY" ]]; then
    command -v go >/dev/null 2>&1 || {
        info "Installing Go to build the agent"
        apt-get install -y --no-install-recommends golang-go >>"$AGENT_LOG" 2>&1 || true
    }
    if command -v go >/dev/null 2>&1; then
        info "Building the agent"
        (cd "$REPO/agent" && go build -o odm-agent .) >>"$AGENT_LOG" 2>&1 || true
        # The network-boot role installs this onto machines it provisions, so
        # it has to be on the controller before that role can be installed.
        (cd "$REPO/client-join" && go build -o odm-client-install ./cmd/odm-client-install) \
            >>"$AGENT_LOG" 2>&1 || true
    fi
fi

AGENT_READY="no"
if [[ -x "$AGENT_BINARY" ]]; then
    if "$HERE/install-agent.sh" \
            --api-url "https://$CONSOLE_FQDN:$PORT" \
            --binary "$AGENT_BINARY" \
            --ca-cert /etc/odm/tls/api.crt >>"$AGENT_LOG" 2>&1; then
        AGENT_READY="yes"
        ok "The agent is running on this controller"
    fi
fi

if [[ "$AGENT_READY" != "yes" ]]; then
    warn "The agent is not running here, so no role can be installed on this"
    warn "machine and it will report nothing to the console."
    # Whatever went wrong is in that log; making the operator go and find it
    # is how the last round of this took an evening.
    if [[ -s "$AGENT_LOG" ]]; then
        warn "The last of $AGENT_LOG:"
        tail -n 12 "$AGENT_LOG" | sed 's/^/      /' >&2
    fi
    warn "Fix it and run:"
    warn "  $HERE/install-agent.sh --api-url https://$CONSOLE_FQDN:$PORT \\"
    warn "      --binary $AGENT_BINARY --ca-cert /etc/odm/tls/api.crt"
fi

echo
if [[ "$READY" == "yes" ]]; then
    printf '%s  Open Directory Manager is running.%s\n' "$GREEN$B" "$R"
else
    printf '%s  Setup finished, but the control plane has not answered yet.%s\n' "$RED$B" "$R"
    echo
    printf '      %s\n' "$(systemctl is-active odm-api 2>/dev/null || true)" \
        | sed 's/^      $//'
    printf '      Its own account of what went wrong:\n\n'
    # The operator should not have to go and find this. A service that will not
    # start is the one thing the installer cannot work around.
    journalctl -u odm-api -n 30 --no-pager 2>/dev/null \
        | sed 's/^/      /' \
        || printf '      journalctl produced nothing.\n'
    echo
    printf '      Follow it with: journalctl -u odm-api -f\n'
    printf '      Restart after a fix with: systemctl restart odm-api\n'
fi

# The console answering on 127.0.0.1 proves nothing to a client, which has to
# find this machine by name first. That name is served by this DC's own DNS.
if [[ "$SKIP_DC" != "yes" ]]; then
    # A name that does not resolve is exactly what the warning below is for.
    RESOLVED="$(getent ahostsv4 "$CONSOLE_FQDN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
    MY_ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [[ -z "$RESOLVED" ]]; then
        echo
        warn "$CONSOLE_FQDN does not resolve, so no client can reach the console."
        warn "The domain's DNS is this machine: systemctl status samba-ad-dc"
    elif [[ -n "$MY_ADDRESS" && "$RESOLVED" != "$MY_ADDRESS" ]]; then
        echo
        warn "$CONSOLE_FQDN resolves to $RESOLVED, but this machine is $MY_ADDRESS."
        warn "Correct it with: samba-tool dns add 127.0.0.1 $REALM ${CONSOLE_FQDN%%.*} A $MY_ADDRESS"
    fi
fi

cat <<DONE

  ${B}Sign in${R}

    https://$CONSOLE_FQDN:$PORT/

    User      Administrator@$REALM
    Password  the domain administrator password you chose

    The certificate is self-signed, so your browser warns once. Accept it,
    or replace the certificate later from Certificates in the console.

  ${B}First things to do${R}

    Wiki          → Quickstart, the whole system in one page
    Group Policy  → create the default policies
    Directory     → add organizational units, then users and groups

  ${B}Join a client${R}

    sudo odm-client-install --domain $REALM --admin-user Administrator

  ${B}On this machine${R}

    systemctl status odm-api
    journalctl -u odm-api -f
    $SECRETS_FILE   settings and secrets

DONE
trap - ERR
