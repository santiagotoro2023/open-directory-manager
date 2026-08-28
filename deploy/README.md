# Deployment

Everything here targets Debian 12 (bookworm) and Debian 13 (trixie). Run it
on dedicated servers or VMs — `provision-dc.sh` reconfigures Samba,
networking and DNS on the host it runs on.

Phase 1 brings up the core role only: Active Directory, Group Policy storage
and DNS, plus the ODM control plane. DHCP, file-server and later roles are
installed afterwards through the role framework, not from here.

## Order of operations

### 1. Domain controller

```
ODM_ADMIN_PASSWORD='...' sudo ./provision-dc.sh \
    --realm corp.example.internal \
    --netbios EXAMPLE \
    --forwarder 9.9.9.9
```

Preconditions: static IP, final fully-qualified hostname set, clock in sync.
The script refuses to run against an already-provisioned host.

Afterwards, `/var/lib/samba/private/tls/ca.pem` signs the DC's LDAPS
certificate. Replace Samba's self-signed TLS material with certificates from
your own CA before production; the API validates the chain and will not fall
back to plaintext LDAP.

### 2. API service account

```
sudo ./create-api-service-account.sh \
    --realm corp.example.internal \
    --api-host odm.corp.example.internal
```

Creates `svc-odm-api` (Domain Users only), registers
`HTTP/odm.corp.example.internal`, and exports a mode-0600 keytab to
`/etc/odm/odm-api.keytab`. Copy it to the API host over a secure channel;
re-exporting invalidates the previous copy.

### 3. Control plane

```
sudo apt-get install -y python3-venv libkrb5-dev libsasl2-dev
sudo python3 -m venv /opt/odm/venv
sudo /opt/odm/venv/bin/pip install /path/to/repo/api
sudo cp odm.env.example /etc/odm/odm.env    # then edit it
sudo chown root:odm /etc/odm/odm.env && sudo chmod 640 /etc/odm/odm.env
sudo ./setup-db.sh                          # creates the DB, applies migrations
sudo install -m 0644 odm-api.service /etc/systemd/system/
sudo systemctl enable --now odm-api
```

TLS certificate and key for the API go in `/etc/odm/tls/api.crt` and
`/etc/odm/tls/api.key` (mode 0640, readable by the `odm` group). There is no
plaintext listener.

### 4. Web UI

```
cd web && npm install && npm run build
```

Serve `web/dist/` over HTTPS from the same origin as the API — the session
cookie is `SameSite=Strict`, and the API rejects state-changing requests from
any origin not in `ODM_ALLOWED_ORIGINS`.

### 5. Policy agent on domain members

On a machine that is already domain-joined (it needs `/etc/krb5.keytab` and a
working `krb5.conf`):

```
sudo ./install-agent.sh \
    --api-url https://odm.corp.example.internal:8443 \
    --binary ./odm-agent \
    --ca-cert ./api-ca.pem
sudo odm-agent apply --force
```

Build the binary with `cd agent && go build -o odm-agent .`. The agent
authenticates with the machine keytab, so it needs no credential of its own.
`install-agent.sh` also installs the packages the appliers depend on
(`cifs-utils`, `libpam-mount`, `nftables`, `dconf-cli`).

If the API runs on the domain controller, set `ODM_SYSVOL_PATH` so group
policy objects are mirrored into LDAP and SYSVOL for GPMC/RSAT; without it
they are ODM-only and live in PostgreSQL.

### 6. Role framework

Installing a role needs root, which the API deliberately does not have:

```
sudo install -d -m 0755 /opt/odm/bin /opt/odm/deploy
sudo install -m 0755 odm-role-install /opt/odm/bin/
sudo install -m 0755 install-*-role.sh /opt/odm/deploy/
sudo install -m 0440 -o root -g root odm-roles.sudoers /etc/sudoers.d/odm-roles
sudo visudo -cf /etc/sudoers.d/odm-roles
```

The sudoers rule grants the `odm` user exactly one command and nothing else.
Roles can then be installed from **Server Roles** in the UI.

### 7. DHCP role (optional, added after the base install)

Run on both nodes of the failover pair:

```
sudo ./install-dhcp-role.sh \
    --ha-role primary \
    --this-url http://dhcp1.corp.example.internal:8080/ \
    --peer-url http://dhcp2.corp.example.internal:8080/ \
    --realm CORP.EXAMPLE.INTERNAL \
    --dns-server 10.10.0.10
```

The script configures a hot-standby Kea pair, a Control Agent bound to the
loopback behind a generated credential, and `kea-dhcp-ddns` pushing leases
into Samba's AD-integrated zones. It prints the `ODM_KEA_*` lines to add to
the secrets file. Secure dynamic update needs the GSS-TSIG hook and a DDNS
keytab; the script tells you if the hook is missing rather than leaving you
with updates Samba silently rejects.

## Verifying Phase 1

```
curl --cacert /etc/odm/tls/ca.crt https://odm.corp.example.internal:8443/api/v1/healthz
```

Then sign in to the web UI as a member of the group named by
`ODM_ADMIN_GROUP`. Any account outside that group must be refused with 403,
and both outcomes must appear in `audit_log`.

## Verifying policy end to end

1. Create a GPO under Group Policy, add a file-deployment setting writing
   `/etc/motd`, and link it to the OU holding a test machine.
2. Run `odm-agent apply --force` on that machine; `/etc/motd` should change.
3. Open the computer object in Directory, choose **Policy**, and confirm the
   GPO is listed as applied and the agent's report shows `success`.
4. Remove the setting, apply again, and confirm the file is removed — the
   agent prunes what it previously owned.
