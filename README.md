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

## Why

A business that wants off Windows usually stays because nothing on Linux
managed a hundred computers as one: the pieces existed — Samba, SSSD,
Kerberos, the browsers' policy files, nftables, CUPS, Kea, FreeRADIUS,
WireGuard — but as a dozen projects with a dozen vocabularies, each needing
its own specialist. ODM drives all of them from one console with one agent,
in Active Directory's own terms, so the person who knows the console knows
the fleet. There is no licence, no telemetry and no cloud account; every
password, log and certificate stays on machines you own. And because the
domain underneath is a standard one, a business is never locked to ODM
either. The console's Wiki has a page on this — **Why Open Directory
Manager** — written for the people who decide rather than the people who
operate.

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
[latest release](https://github.com/santiagotoro2023/open-directory-manager/releases)
and run one command:

```bash
sudo apt update
sudo DEBIAN_FRONTEND=noninteractive apt install ./odm-client_0.16.9_amd64.deb
sudo odm-client-install --domain corp.example.internal --admin-user Administrator
```

The refresh matters on a machine installed from an older image: the package
pulls in Samba and SSSD, and an index older than the archive's last point
release asks for filenames the mirror has already pruned.

Without `--admin-user` it prompts. There is no graphical installer — one
command that runs the same way scripted and interactive, so what a person
does at a desktop is what an unattended install does. The client needs
nothing but the domain and a credential: the console's
certificate is published in the domain's SYSVOL and the join reads it from
there over Kerberos, so there is no file to carry to each machine.

The machine appears under **Directory**. Opening it shows what policy it
received, its local accounts, who has signed in, what is installed, and its
recent logs.

Leaving again needs a domain credential to remove the computer account, or
`--force` to disconnect this machine alone:

```bash
sudo odm-client-install --leave --domain corp.example.internal --admin-user Administrator
```

### Upgrading

Setup is the upgrade path: steps that already completed are skipped, an
existing domain is never re-provisioned, and the console certificate is left
alone. On the controller:

```bash
sudo git pull
sudo deploy/setup.sh --console-fqdn <this controller's name>
```

It rebuilds the console, reinstalls the control plane, rebuilds the agent and
restarts both; database migrations run when the control plane starts.

### Moving a domain, or starting one from another

`Overview → Configuration → Download the configuration` writes every object,
zone and setting in the domain to one readable JSON file. Give it to a fresh
install and it comes up configured the same way:

```bash
sudo deploy/setup.sh --realm corp.example.internal --netbios EXAMPLE \
    --import /root/odm-corp.example.internal.json
```

Credentials are deliberately not in the file — private keys, shared secrets,
rotated local-administrator passwords, join tokens and password hashes are
withheld, and the file says which. Accounts come back disabled and without a
password. This is not a substitute for a domain backup: a backup recovers
*this* domain with its identifiers intact, an export builds another one
configured the same way.

### Doing it by hand

Each step of the guided setup is its own script under `deploy/`, and
[deploy/README.md](deploy/README.md) walks through them individually along
with the optional roles — DHCP, file server, certificate authority and PXE.

---

## What you get

| Area | Capability |
|---|---|
| Directory | Users, groups, computers and organizational units — create, edit, move, delete, bulk CSV import, one action that offboards a leaver, one change applied to a selection of objects, and groups whose membership is a query rather than a list |
| Group Policy | Policy objects with links, precedence, enforced links, blocked inheritance, security filtering, item-level targeting, a full change history with one-button rollback, modelling a link before making it, export/import as portable JSON, and settings filed into collapsible folders so a long list stays navigable |
| Policy settings | Files, scripts, systemd units, cron, firewall, drive maps, roaming profiles, printers, sudo rules, HBAC rules, trusted certificates and the domain's own authority in one setting — trusted by the system and the browsers, with a certificate for the machine itself — Wi-Fi networks joined before anyone signs in, with 802.1X and that machine certificate or a pre-shared key, login screen (including a background picture that actually appears at GNOME's greeter, not only in the setting), desktop background, browser policy, apt package deployment, a `.deb` uploaded directly for software with no apt repository to reach, graphics drivers detected from the hardware or named directly, unattended updates, always-on VPN, remote desktop session rules, default applications per file type, the dash layout per user or group (optionally left alone once seeded, for someone free to rearrange their own), desktop shortcuts and file-manager bookmarks, fonts and the desktop theme, the local password policy, boot loader wait and menu visibility, a graphical boot splash with a background, a logo and a message in place of Debian's own kernel and initramfs text, kernel parameters, power and screen-lock behaviour, removable-storage rules, a second factor at the machine, an allowlist for what may be installed, what the first sign-in shows, agent updates, regional settings (language, formats, keyboard and time zone), Bluetooth, cameras and microphones allowed or blocked machine-wide, computer names from a template (`WS-{n:4}`) with the next free number handed out by the console and the account, keytab and DNS record renamed to match, logon hours per person or group with an optional forced sign-out, firmware updates through fwupd, web sites installed as programs with an icon and a window of their own, the domain's password manager on the machine — Bitwarden's browser extension and/or desktop app, pointed at the domain's vault, the browsers trusting the console with the desktop's Kerberos ticket so the vault's sign-in needs no typing, and both removed when the setting goes — and a local administrator whose password each machine rotates itself — removed from a machine the moment the policy stops naming one. A setting applies for exactly as long as a policy object says it should, and is taken back when it stops |
| Roaming profiles | A home directory on a share that follows the person between desktops and session hosts, as a disk image per person or a directory. The same mechanism a remote desktop collection uses, so one profile can serve both |
| Browsers | Firefox and Chromium/Chrome as plain settings — start page, managed bookmarks, extensions to install or forbid, password manager, autofill, history, private browsing, developer tools, telemetry, accounts and sync, pop-ups, search engine, downloads, proxy, blocked sites, first-run pages — turned into each browser's own managed policy by the control plane, with anything else by its native policy name |
| Administrative templates | Vendor ADMX/ADML import with generated forms |
| DNS | Zones and records in the domain's integrated DNS |
| DHCP | ISC Kea scopes, reservations, leases, failover pair and dynamic DNS |
| File shares | SMB shares on any file server, with per-user and per-group access levels, choosing the directory by browsing the server itself |
| Printing | CUPS printers on any print server, found on the network by scanning for them, handed to people by policy |
| Remote desktop | Collections of session hosts behind a broker that returns people to the session they left, profile disks on a share you can grow or reset from the console, published applications, and connection files that arrive on a desktop with something installed that opens them. A session host serves XFCE, GNOME or KDE Plasma, chosen when the role is installed. An optional standby broker sharing one affinity table, and one DNS name published across both. A host is drained rather than removed while it is patched. The broker owns 3389; a host sharing its machine moves to 3390 |
| Remote access | WireGuard tunnels, exportable client configurations, and always-on for managed machines |
| Network access | RADIUS for wired, wireless and VPN sign-in, with per-group rules and VLAN assignment; EAP-TLS checked against the domain authority, so a machine with the certificate the domain issued it is a machine that may join the Wi-Fi |
| Client enrolment | Unattended Debian installation over the network, joining the domain on first boot |
| Machine management | Model, serial and drive health from SMART, installed software, local accounts to add and remove, sign-in history, a message on the screens of whoever is signed in (one machine or a selection), watching a signed-in person's screen with their consent — in a tab of the console itself, the VNC server on the machine's loopback and its bytes carried by the agent, so there is nothing to install and nothing to type — recent logs filtered to errors and exportable, updates, restart, a remote agent update, a terminal — a real root login shell on a pseudo-terminal, carried over the agent's own connection, its whole transcript in the audit log when it ends — a file browser that shows and changes owner, group and mode, and disk-encryption status with an escrowed recovery key — on the computer object itself, starting within a second rather than at the next check-in |
| Certificates | An internal CA that issues certificates, autoenrols and renews them for machines, publishes trust by policy at the moment it is created, takes profiles of your own beside the built-in pair, re-issues the console's own certificate, and withdraws one to a revocation list every issued certificate points at |
| Passwords | The local password policy for accounts that live on a machine itself, set as a policy-object setting; helpdesk resets. The domain's own password rules are set with `samba-tool domain passwordsettings`, the way any AD-compatible tool sets them, rather than duplicated as console state |
| Password manager | A role that runs Vaultwarden (the open-source Bitwarden server) on a member server and makes it part of the domain — reached at the console's own address, `/vault`, shown inside the Passwords page and carried to whichever server holds it over TLS the console verifies, so there is one address, one certificate and one sign-in: seats and the organisation's groups come from the domain groups you choose, kept in step by Bitwarden's directory connector on a timer with a read-only account the console makes; people sign in with their domain account, through the console — the domain's OpenID Connect provider — with no prompt at all from a domain-joined desktop; the certificate comes from the domain authority; and the extension and the desktop app arrive on workstations by policy, already pointed at the vault. Each person's master password stays their own: it is what encrypts their vault, and nothing on the server can stand in for it |
| Pictures | A person's picture set on their account and shown by every machine they sign in to, at the login screen and in the desktop |
| Sign-in | A second factor, enrolled once with a QR code and asked for at the console and at the machine alike — on screen, over SSH, at sudo or over remote desktop — or approved with a tap on the phone instead: an Approve / Deny notification through a self-hosted [ntfy](https://ntfy.sh) server that the domain controller's setup installs (every release also ships a build of the ntfy Android app that trusts a self-signed server on a scanned code), nothing leaving the domain. The policy object is the source of truth: a method it stops asking for takes its enrolments with it, and an administrator can reset one account's second factor from its right-click menu or every account's from the Overview. Somebody who has not enrolled is walked through it at their next sign-in, full screen, and cannot get past it; the phone is set up the same way, and a policy can name the public address phones use when port 8444 is forwarded through a router |
| Sites | Sites and subnets, so a machine reports where it is and prefers a controller near it |
| Delegation | Roles and permissions scoped to an organizational unit, including a read-only role that sees everything and changes nothing |
| Domain controllers | Which controllers exist, which are read-only, and replication between them; a default organizational unit for a computer that joins without naming one itself |
| Operations | Health dashboard on Overview, replication, domain backups taken by the controller's own agent, a security baseline measuring the domain against a checklist, and a configuration export: every object, zone and setting in one readable file, importable into a new domain from the console or from `setup.sh --import` |
| Recycle bin | Every delete snapshotted and restorable within the retention window, into its old container or another one, keeping the security identifier it had |
| Monitoring | A role that has every machine report processor, memory, filesystems, network and temperature once a minute and the node carrying it probe what has no agent — ping, a port, a page; rules that open and resolve alerts per series, with severities, scopes (every machine, a group, one machine) and how long a condition must hold; channels — an ntfy topic with a code to scan, or a webhook; maintenance windows that keep planned work from paging anyone; and dashboards designed in the console from charts, current values, the machine table and open alerts, one of them the default, any of them shareable as a full-screen link for a screen on a wall |
| Audit | Every change with actor, outcome and before-and-after state |
| Activity | What people did at the machines, from every machine's own journal in one place: each sign-in and failed one, each sudo command and refused one, su, phone approvals and refusals, password changes, local accounts, USB devices, boots — filterable by machine, person, kind and time, on a computer object, on a user object, or domain-wide, and exportable as CSV |
| Clients | One `.deb`: `odm-client-install`, `odm-agent` and the role installers. The join configures the resolver, Samba, Kerberos and SSSD, and starts the agent |

## Architecture

| Layer | Implementation |
|---|---|
| Directory, Kerberos, DNS, SYSVOL | Samba Active Directory DC |
| Control plane | Python + FastAPI (`api/`) — the only component that speaks LDAP and Kerberos |
| Metadata store | PostgreSQL — audit log, delegation, policy objects, recycle bin, role registry, certificate inventory |
| Console | React + TypeScript (`web/`), talks only to the control plane, and re-reads itself when the domain changes |
| Policy agent | Go, one static binary (`agent/`) |
| Domain join | Go library with a CLI (`client-join/`) |
| DHCP | ISC Kea, through its Control Agent |
| File shares | Samba, with POSIX access lists |
| Printing | CUPS, driverless or with an uploaded PPD |
| Remote access | WireGuard |
| Network access | FreeRADIUS, against the directory through winbind |
| Password manager | Vaultwarden in a podman quadlet, carried under the console's `/vault` by the control plane (`api/odm/vaultproxy.py`); Bitwarden's directory connector for seats and groups; the control plane as an OpenID Connect provider (`api/odm/oidc.py`) for sign-in |
| Monitoring | The agent reading /proc and /sys; PostgreSQL holding a fortnight of samples; uPlot in the console |
| Unattended install | Debian's own installer, preseeded, over proxy DHCP |

Directory objects always live in Samba's LDAP; PostgreSQL is never the source
of truth for them.

The console does not poll. A trigger in PostgreSQL names the table that
changed, the control plane streams that name to every open console over
server-sent events, and each page re-reads what it is showing with its own
request. Nothing about the change travels in the stream, so a page never shows
somebody something their session could not have asked for.

LDAP connections are pooled and every search follows the directory's pages, so
a container with more than a thousand objects is listed completely rather than
quietly cut short.

The control plane can only run a command on its own host, so anything it needs
done on another machine — installing a role, publishing a share or a printer,
bringing up a tunnel, installing updates — is queued and collected by that
machine's agent, which authenticates with the Kerberos identity domain join
gave it. Nothing connects inward to a member server.

## Layout

```
api/          Control plane and database migrations
agent/        Policy agent for domain members
client-join/  Join library and odm-client-install
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
bash packaging/deb/build-in-container.sh 0.16.9   # -> dist/odm-client_0.16.9_amd64.deb
```

That builds both front ends in a container, so nothing but Docker is needed on
the machine doing it — the desktop half wants an X11 and a Wayland toolchain.
`packaging/deb/build.sh` builds directly if you already have those.

Pushing a `v*` tag attaches the package to a GitHub release, as does running
the CI workflow from the Actions tab with a version — that path creates the
tag itself, and refuses to publish a version the tree does not already carry.

## Repository

https://github.com/santiagotoro2023/open-directory-manager

Issues and pull requests are welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
