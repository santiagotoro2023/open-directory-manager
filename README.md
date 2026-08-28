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

On a **fresh Debian 12 or 13 server** with a static address:

```bash
git clone https://github.com/santiagotoro2023/open-directory-manager.git
cd open-directory-manager
sudo deploy/setup.sh
```

That is the whole install. It asks what to call the domain, sets this
machine's name if it does not have a full one yet, provisions the domain
controller, installs the control plane, sets up TLS and the database, builds
the console, starts everything, and finishes by telling you the address to
sign in at:

```
  Sign in

    https://dc1.corp.example.internal:8443/

    User      Administrator@corp.example.internal
    Password  the domain administrator password you chose
```

The certificate is self-signed, so the browser warns once. Sign in, then open
**Wiki** in the console — the full operator documentation is there, starting
with a Quickstart for the whole system.

Setup takes flags for an unattended run:

```bash
sudo deploy/setup.sh \
  --realm corp.example.internal \
  --netbios EXAMPLE \
  --forwarder 9.9.9.9 \
  --yes
```

It is safe to run again: anything already done is skipped, and a failure
names the step it stopped at.

### Joining a client

```bash
sudo odm-client-install --domain corp.example.internal --admin-user Administrator
sudo odm-agent apply --force
```

The machine appears under **Directory**, and **Directory → the computer →
Policy** shows what it received.

### Doing it by hand

Each step of the guided setup is its own script under `deploy/`, and
[deploy/README.md](deploy/README.md) walks through them individually along
with the optional roles — DHCP, file server, certificate authority and PXE.

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

## Repository

https://github.com/santiagotoro2023/open-directory-manager

Issues and pull requests are welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
