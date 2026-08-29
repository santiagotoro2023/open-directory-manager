<p align="center">
  <img src="branding/odm-logo-full.svg" alt="Open Directory Manager" width="420">
</p>

# Open Directory Manager

A Windows-compatible directory domain on Linux, with the console to run it. A
Samba domain controller holds the directory, Kerberos, DNS and SYSVOL; ODM
adds the control plane, the web console, Group Policy that Debian clients
actually enforce, and the services around it — DHCP, file shares, printing,
remote access, a certificate authority, unattended installation — each
installable on any joined machine, not only the controller.

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

Download `odm-client_*.deb` from the
[latest release](https://github.com/santiagotoro2023/open-directory-manager/releases),
open it, and use **Join a Domain** from the applications menu. Or from a
terminal:

```bash
sudo apt install ./odm-client_0.1.0_amd64.deb
sudo odm-client-install --domain corp.example.internal --admin-user Administrator
```

The machine appears under **Directory**. Opening it shows what policy it
received, its local accounts, who has signed in, what is installed, and its
recent logs.

Leaving again needs a domain credential to remove the computer account, or
`--force` to disconnect this machine alone:

```bash
sudo odm-client-install --leave --domain corp.example.internal --admin-user Administrator
```

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
| Policy settings | Files, scripts, systemd units, cron, firewall, drive maps, printers, sudo rules, HBAC rules, trusted certificates, login screen, desktop background, browser policy, software deployment, unattended updates, always-on VPN |
| Administrative templates | Vendor ADMX/ADML import with generated forms |
| DNS | Zones and records in the domain's integrated DNS |
| DHCP | ISC Kea scopes, reservations, leases, failover pair and dynamic DNS |
| File shares | SMB shares on any file server, with per-user and per-group access levels |
| Printing | CUPS printers on any print server, handed to people by policy |
| Remote access | WireGuard tunnels, exportable client configurations, and always-on for managed machines |
| Network access | RADIUS for wired, wireless and VPN sign-in, with per-group rules and VLAN assignment |
| Client enrolment | Unattended Debian installation over the network, joining the domain on first boot |
| Machine management | Installed software, local accounts, sign-in history, recent logs, updates, restart — per machine, from its own page |
| Certificates | An internal CA that issues certificates, autoenrols and renews them for machines, publishes trust by policy, and re-issues the console's own certificate |
| Passwords | Domain password policy, helpdesk resets, and self-service change gated by policy |
| Delegation | Roles and permissions scoped to an organizational unit |
| Servers | Every joined machine, the roles it carries, and its agent's state |
| Domain controllers | Which controllers exist, which are read-only, and replication between them |
| Operations | Health dashboard on Overview, replication, domain backups |
| Recycle bin | Every delete snapshotted and restorable within the retention window |
| Audit | Every change with actor, outcome and before-and-after state |
| Clients | One `.deb`: `odm-client-install` for scripts, **Join a Domain** for the desktop. `odm-agent` applies and reports policy |

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
| File shares | Samba, with POSIX access lists |
| Printing | CUPS, driverless or with an uploaded PPD |
| Remote access | WireGuard |
| Network access | FreeRADIUS, against the directory through winbind |
| Unattended install | Debian's own installer, preseeded, over proxy DHCP |

Directory objects always live in Samba's LDAP; PostgreSQL is never the source
of truth for them.

The control plane can only run a command on its own host, so anything it needs
done on another machine — installing a role, publishing a share or a printer,
bringing up a tunnel, installing updates — is queued and collected by that
machine's agent, which authenticates with the Kerberos identity domain join
gave it. Nothing connects inward to a member server.

## Layout

```
api/          Control plane and database migrations
agent/        Policy agent for domain members
client-join/  Join library, odm-client-install, desktop join app
web/          Console, including the operator wiki under web/src/wiki
deploy/       Provisioning, role installers, systemd units, sudoers
packaging/    The odm-client Debian package
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
push, and builds the client package:

```bash
bash packaging/deb/build.sh 0.1.0     # -> dist/odm-client_0.1.0_amd64.deb
```

Pushing a `v*` tag attaches it to a GitHub release.

## Repository

https://github.com/santiagotoro2023/open-directory-manager

Issues and pull requests are welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
