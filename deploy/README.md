# Deployment

Everything here targets Debian 12 (bookworm) and Debian 13 (trixie). Run it
on dedicated servers or VMs — `provision-dc.sh` reconfigures Samba,
networking and DNS on the host it runs on.

Bring-up installs the core role only: Active Directory, Group Policy and
DNS, plus the ODM control plane and its console. DHCP, file-server,
certificate-authority and PXE are installed afterwards through the role
framework, from **Server Roles** in the console.

| Script | Runs on | Purpose |
|---|---|---|
| `provision-dc.sh` | The first domain controller | Provisions the domain |
| `create-api-service-account.sh` | A domain controller | The control plane's account, SPN, keytab and delegated rights |
| `generate-self-signed.sh` | The control-plane host | The console's first TLS certificate |
| `setup-db.sh` | The control-plane host | PostgreSQL role, database and schema |
| `odm-apply-console-certificate` | The control-plane host | Installs a console certificate issued by the domain authority |
| `install-dhcp-role.sh` | Each DHCP node | ISC Kea failover pair with dynamic DNS |
| `install-file-server-role.sh` | A file server | Kerberos SMB shares for drive maps |
| `install-certificate-authority-role.sh` | The control-plane host | Prepares the certificate authority directory |
| `install-print-server-role.sh` | Any joined server | CUPS, shared to the domain |
| `install-vpn-role.sh` | Any joined server | WireGuard, for remote access |
| `install-radius-role.sh` | Any joined server | FreeRADIUS, against the directory |
| `install-pxe-role.sh` | A boot server | Unattended installation that joins on first boot |
| `install-agent.sh` | An already-joined machine | The policy agent alone |

## Guided setup

For a single-server deployment, one command does all of it:

```
sudo ./setup.sh
```

It asks what to call the domain, sets this machine's fully-qualified name if
it does not have one, and runs the steps below in order, finishing with the
address to sign in at. `--yes` with the flags in `setup.sh --help` makes it
unattended. It can be run again; completed steps are skipped.

The rest of this document covers the same steps individually, for
deployments that are not a single server.

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

Debian spreads a domain controller across several packages, and moved two of
them between releases:

| | Debian 12 | Debian 13 |
|---|---|---|
| `samba-tool` | `samba-common-bin` | `python3-samba` |
| `samba-ad-dc.service` | `samba` | `samba-ad-dc` |
| AD schema for provisioning | `samba-ad-provision` | `samba-ad-provision` |

The script installs whichever the running release has, with recommends,
and verifies `samba-tool`, the service unit and the schema are all present
before it provisions anything.

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

The console is served over HTTPS from the first boot. Generate its first
certificate before starting the service:

```
sudo ./generate-self-signed.sh --fqdn odm.corp.example.internal
```

That writes `/etc/odm/tls/api.crt` and `/etc/odm/tls/api.key` (0640,
root:odm). There is no plaintext listener. Once the certificate-authority
role is installed, the console can re-issue its own certificate from the
domain's authority under **Certificates → Replace console certificate**.

### 4. Console

```
cd web && npm install && npm run build
sudo cp -r dist /opt/odm/console
```

Point `ODM_CONSOLE_DIR` at that directory and the control plane serves the
console itself, so the two share an origin without a proxy in front. The
session cookie is `SameSite=Strict`, and the API rejects state-changing
requests from any origin not in `ODM_ALLOWED_ORIGINS`.

To serve the console from somewhere else instead, leave `ODM_CONSOLE_DIR`
unset and put a reverse proxy in front of both.

Then, signed in as a domain administrator, open **Group Policy** and create
the default policies. The operator documentation is inside the console under
**Wiki**.

### 5. Policy agent on domain members

Machines are normally joined with `odm-client-install`, which installs and
enables the agent as part of the join — see the **Joining machines** page in
the console wiki. The steps below install the agent alone on a machine that
is already joined.


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

`ODM_SYSVOL_PATH` mirrors group policy objects into LDAP and SYSVOL for
GPMC and RSAT. It is off after a standard install: the control-plane service
account needs write access to Samba's SYSVOL share, and `ReadWritePaths` in
`odm-api.service` extended to cover it. Without it, policy objects live in
PostgreSQL and agents are unaffected.

### 6. Role framework

Installing a role means `apt` and service restarts. The control plane runs
under `ProtectSystem=strict` with `NoNewPrivileges`, so it cannot do that even
on its own host — sudo would not help, because the read-only mount namespace
is inherited by anything it starts. Every install is handed to the agent on
the target machine, which runs as root:

```
sudo ./install-agent.sh --api-url https://<console fqdn>:8443 --binary ./odm-agent
```

`setup.sh` does this for the controller as its last step. A controller with no
agent shows up in the console but nothing can be installed on it.

### 7. Certificate-authority role (optional)

Install it from **Server Roles** in the console. Add the printed
`ODM_CA_DIR` to the secrets file and restart the API, then open
**Certificates** and create the root. **Publish to domain** writes the root
into a group policy object linked at the domain head, so agents install it
into `/usr/local/share/ca-certificates` and run `update-ca-certificates` on
their next refresh.

### 8. DHCP role (optional, added after the base install)

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

## Verifying the installation

```
curl --cacert /etc/odm/tls/ca.crt https://odm.corp.example.internal:8443/api/v1/healthz
```

Then sign in to the console as a member of the group named by
`ODM_ADMIN_GROUP`. An account that is neither in that group nor holds a
delegated assignment must be refused, and both outcomes must appear in the
audit log.

Under **Operations → Health**, every card should report. Cards for roles that
are not installed say so rather than erroring.

## Verifying policy end to end

1. Create a GPO under Group Policy, add a file-deployment setting writing
   `/etc/motd`, and link it to the OU holding a test machine.
2. Run `odm-agent apply --force` on that machine; `/etc/motd` should change.
3. Open the computer object in Directory, choose **Policy**, and confirm the
   GPO is listed as applied and the agent's report shows `success`.
4. Remove the setting, apply again, and confirm the file is removed — the
   agent prunes what it previously owned.
