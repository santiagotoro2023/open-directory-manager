<p align="center">
  <img src="branding/odm-logo-full.svg" alt="Open Directory Manager" width="420">
</p>

# Open Directory Manager

Open-source Linux replacement for the core of Windows Active Directory —
directory, Kerberos, DNS, Group Policy, DHCP and the admin console that
drives them, with the terminology and object model a Windows admin already
knows: Organizational Unit, Group Policy Object, Sudo Rule, HBAC.

## Architecture

| Layer | Implementation |
|---|---|
| Directory / Kerberos / DNS / SYSVOL | Samba Active Directory DC (real AD wire protocol) |
| Control-plane API | Python + FastAPI (`api/`) — the only thing that talks LDAP/Kerberos |
| ODM metadata store | PostgreSQL — audit log, RBAC, recycle bin, role registry, GPO-link cache |
| Client policy agent | Go, single static binary (`agent/`) |
| Domain-join client | Go join library + `odm-client-install` CLI + Fyne GUI (`client-join/`) |
| Web UI | React + TypeScript SPA (`web/`), API-only — never LDAP directly |
| DHCP | ISC Kea, driven through its Control Agent HTTP API |

Directory objects always live in Samba's LDAP; PostgreSQL is never the
source of truth for them.

## Layout

```
api/          FastAPI control plane, Postgres migrations
agent/        Go policy agent (Phase 3)
client-join/  Go join library, CLI and GUI (Phase 3)
web/          React SPA
deploy/       Samba AD DC provisioning, Kea, systemd units
docs/
branding/     Logo assets and brand rules — see branding/BRAND.md
```

## Status

Phase 1 (Foundation) is implemented: Samba AD DC provisioning automation,
the PostgreSQL metadata schema, the FastAPI skeleton with Kerberos/LDAP
authentication gated on the Domain-Admins-equivalent group, and the React
shell with its login flow. Later phases are tracked in
[CLAUDE.md](CLAUDE.md) §7.

## Full specification

[CLAUDE.md](CLAUDE.md) is the authoritative build specification — read it
before contributing. [CONTRIBUTING.md](CONTRIBUTING.md) covers workflow.

## Getting started

Bring-up is documented in [deploy/README.md](deploy/README.md). ODM is
designed for Debian 12 (bookworm) and Debian 13 (trixie); do not provision
a domain controller on a workstation you care about.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
