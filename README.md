<p align="center">
  <img src="branding/odm-logo-full.svg" alt="Open Directory Manager" width="420">
</p>

# Open Directory Manager

An Active Directory domain on Linux, with the console to run it. A Samba
domain controller holds the directory, Kerberos, DNS and SYSVOL; ODM adds the
control plane, the web console, Group Policy that Debian clients actually
enforce, DHCP, a certificate authority, delegated administration and a full
audit trail.

Terminology is the one an AD or FreeIPA administrator already has:
Organizational Unit, Group Policy Object, Distinguished Name, Sudo Rule,
HBAC rule, user group, computer group.

---

## Quickstart

Everything below runs on a **fresh Debian 12 or 13 server** with a static
address and its final host name set. `provision-dc.sh` reconfigures Samba,
networking and DNS — do not run it on a machine you care about.

```bash
git clone https://github.com/<your-org>/open-directory-manager.git
cd open-directory-manager
```

**1. Provision the domain controller**

```bash
sudo deploy/provision-dc.sh \
    --realm corp.example.internal \
    --netbios EXAMPLE \
    --forwarder 9.9.9.9
```

It prompts for the domain administrator password.

**2. Create the control plane's service account**

```bash
sudo deploy/create-api-service-account.sh \
    --realm corp.example.internal \
    --api-host odm.corp.example.internal
```

**3. Install the control plane**

```bash
sudo apt-get install -y python3-venv libkrb5-dev libsasl2-dev
sudo python3 -m venv /opt/odm/venv
sudo /opt/odm/venv/bin/pip install ./api

sudo install -d -m 0750 /etc/odm
sudo cp deploy/odm.env.example /etc/odm/odm.env   # then edit it
sudo chown root:odm /etc/odm/odm.env && sudo chmod 640 /etc/odm/odm.env

sudo deploy/generate-self-signed.sh --fqdn odm.corp.example.internal
sudo deploy/setup-db.sh

sudo install -m 0644 deploy/odm-api.service /etc/systemd/system/
sudo systemctl enable --now odm-api
```

**4. Build the console**

```bash
cd web && npm install && npm run build
sudo cp -r dist /opt/odm/console
```

`ODM_CONSOLE_DIR=/opt/odm/console` in `/etc/odm/odm.env` makes the control
plane serve it, so the console and the API share an origin. Restart the
service after setting it.

**5. Sign in and finish setup**

Open `https://odm.corp.example.internal:8443/` and sign in as a member of
**Domain Admins**. Then:

- **Group Policy → Create defaults** for the Default Domain Policy and
  Default Domain Controllers Policy.
- **Wiki** in the left-hand navigation — the full operator documentation
  lives inside the console.

**6. Join your first client**

```bash
# on the client, already resolving the domain's DNS
sudo odm-client-install --domain corp.example.internal --admin-user Administrator
sudo odm-agent apply --force
```

Confirm it arrived: **Directory → select the computer → Policy**.

Full bring-up notes, optional roles and the verification steps are in
[deploy/README.md](deploy/README.md).

---

## What you get

| Area | Capability |
|---|---|
| Directory | Users, groups, computers and organizational units — create, edit, move, delete, bulk CSV import |
| Group Policy | Policy objects with links, precedence, enforced links, blocked inheritance, security filtering and item-level targeting |
| Policy settings | Files, scripts, systemd units, cron, firewall, drive maps, sudo rules, HBAC rules, trusted certificates, desktop background, browser policy, software deployment |
| Administrative templates | Vendor ADMX/ADML import with generated forms |
| DNS | Zones and records in the domain's integrated DNS |
| DHCP | ISC Kea scopes, reservations, leases, failover pair and dynamic DNS |
| Certificates | An internal CA that issues certificates, publishes trust by policy, and re-issues the console's own certificate |
| Delegation | Roles and permissions scoped to an organizational unit |
| Operations | Health dashboard, replication between controllers, domain backups |
| Recycle bin | Every delete snapshotted and restorable within the retention window |
| Audit | Every change with actor, outcome and before-and-after state |
| Clients | `odm-client-install` and a desktop join app; `odm-agent` applies and reports policy |

## Architecture

| Layer | Implementation |
|---|---|
| Directory, Kerberos, DNS, SYSVOL | Samba Active Directory DC |
| Control plane | Python + FastAPI (`api/`) — the only component that speaks LDAP and Kerberos |
| Metadata store | PostgreSQL — audit log, delegation, policy objects, recycle bin, role registry, certificate inventory |
| Console | React + TypeScript (`web/`), talks only to the control plane |
| Policy agent | Go, one static binary (`agent/`) |
| Domain join | Go library with a CLI and a desktop app (`client-join/`) |
| DHCP | ISC Kea, through its Control Agent |

Directory objects always live in Samba's LDAP; PostgreSQL is never the source
of truth for them.

## Layout

```
api/          Control plane and database migrations
agent/        Policy agent for domain members
client-join/  Join library, odm-client-install, desktop join app
web/          Console, including the operator wiki under web/src/wiki
deploy/       Provisioning, role installers, systemd units, sudoers
docs/         Repository notes and build status
branding/     Logo assets — see branding/BRAND.md
```

## Documentation

- **Operator documentation** is in the console under **Wiki**, written in
  `web/src/wiki/`. Every page opens with a Quickstart and continues into
  Details.
- **Deployment**: [deploy/README.md](deploy/README.md)
- **Control plane internals**: [api/README.md](api/README.md)
- **Agent**: [agent/README.md](agent/README.md) ·
  **Join client**: [client-join/README.md](client-join/README.md)
- **Build status against the specification**: [docs/README.md](docs/README.md)
- **Specification**: [CLAUDE.md](CLAUDE.md) ·
  **Contributing**: [CONTRIBUTING.md](CONTRIBUTING.md)

## Requirements

- Debian 12 (bookworm) or Debian 13 (trixie), for controllers, members and
  desktops
- Python 3.11+, Node 22+, Go 1.25+ to build from source
- PostgreSQL for the control plane's own metadata

## Development

```bash
cd api         && pip install -e ".[dev]" && pytest && ruff check .
cd agent       && go test ./... && go vet ./...
cd client-join && go test ./... && go vet ./...
cd web         && npm install && npm run build
```

CI runs all of that plus `pip-audit`, `npm audit` and `govulncheck` on every
push.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
