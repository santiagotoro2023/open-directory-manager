# Documentation

Operator documentation lives here. The product itself stays uncluttered — no
inline tooltips explaining why a setting exists (CLAUDE.md §1); explanation
belongs in these pages.

| Document | Contents |
|---|---|
| [../CLAUDE.md](../CLAUDE.md) | Authoritative build specification |
| [../deploy/README.md](../deploy/README.md) | Bring-up: domain controller, database, API, UI |
| [../api/README.md](../api/README.md) | Control-plane API internals and endpoints |
| [../agent/README.md](../agent/README.md) | Policy agent |
| [../client-join/README.md](../client-join/README.md) | Domain-join CLI and GUI |
| [../branding/BRAND.md](../branding/BRAND.md) | Logo usage, palette, typography |

## Build status against CLAUDE.md §7

| Phase | Scope | State |
|---|---|---|
| 1 | Samba AD DC provisioning, Postgres schema, FastAPI + Kerberos/LDAP auth with the domain-admin gate, React shell and login | Implemented |
| 2 | Users/Groups/Computers/OUs CRUD, audit logging wired into every write | Not started |
| 3 | GPO object model, precedence resolution, agent pull/apply/report loop, file/script/systemd appliers | Not started |
| 4 | Drive maps, browser policy, wallpaper, sudo and logon scope, cron | Not started |
| 5 | ADMX/ADML importer and dynamic settings UI | Not started |
| 6 | DHCP role via Kea, DDNS sync, HA pairing | Not started |
| 7 | Recycle bin, roles/extensibility framework | Not started |
| 8 | Hardening pass, delegated admin, backup/restore, replication topology | Not started |

Phase 1 lays groundwork for later phases in the database schema (RBAC and
delegation, recycle bin, role registry, GPO links) so those phases add code,
not migrations that rewrite what is already deployed.
