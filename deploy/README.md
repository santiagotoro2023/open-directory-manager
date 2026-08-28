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

## Verifying Phase 1

```
curl --cacert /etc/odm/tls/ca.crt https://odm.corp.example.internal:8443/api/v1/healthz
```

Then sign in to the web UI as a member of the group named by
`ODM_ADMIN_GROUP`. Any account outside that group must be refused with 403,
and both outcomes must appear in `audit_log`.
