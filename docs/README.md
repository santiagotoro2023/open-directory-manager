# Documentation

Operator documentation ships inside the console, under **Wiki**. It is
written in `web/src/wiki/` and covers every component, with a Quickstart at
the top of each page and full detail below. The files here describe the
repository itself.

| Document | Contents |
|---|---|
| [../CLAUDE.md](../CLAUDE.md) | Authoritative build specification |
| [../deploy/README.md](../deploy/README.md) | Bring-up: domain controller, database, API, UI |
| [../api/README.md](../api/README.md) | Control-plane API internals and endpoints |
| [../agent/README.md](../agent/README.md) | Policy agent |
| [../client-join/README.md](../client-join/README.md) | Domain-join CLI |
| [../branding/BRAND.md](../branding/BRAND.md) | Logo usage, palette, typography |
| `web/src/wiki/` | The operator wiki, served inside the console under **Wiki** |
| [../README.md](../README.md) | Overview and quickstart |

## Build status against CLAUDE.md §7

| Phase | Scope | State |
|---|---|---|
| 1 | Samba AD DC provisioning, Postgres schema, FastAPI + Kerberos/LDAP auth with the domain-admin gate, React shell and login | Implemented |
| 2 | Users/Groups/Computers/OUs CRUD, audit logging wired into every write | Implemented |
| 3 | GPO object model, precedence resolution, agent pull/apply/report loop, file/script/systemd appliers | Implemented |
| 4 | Drive maps, browser policy, wallpaper, sudo scope, HBAC, cron | Implemented |
| 5 | ADMX/ADML importer and dynamic settings UI | Implemented |
| 6 | DNS management, DHCP role via Kea, DDNS sync, HA pairing | Implemented |
| 7 | Recycle bin, roles/extensibility framework | Implemented |
| 8 | Hardening pass, delegated admin, backup, replication topology, health | Implemented |

Beyond the phases, from CLAUDE.md §4: a certificate-authority role with
trust distribution and console certificate rollover, software deployment as
a policy category, a PXE client-enrolment role, and the domain-join client
in both its command-line and desktop forms.

Phase 1 lays groundwork for later phases in the database schema (RBAC and
delegation, recycle bin, role registry, GPO links) so those phases add code,
not migrations that rewrite what is already deployed.

Restoring from the recycle bin recreates an object from its snapshot: the
attributes come back, the group memberships are rejoined, and a restored
group gets its members back. What does not come back is the original SID and
GUID — the directory issues new ones — so access rules that named the old SID
need re-granting, and restored accounts arrive disabled because they have no
password. This is inherent to snapshot restore, which CLAUDE.md §5.3 chooses
deliberately over depending on Samba's tombstone fidelity.

Role installation needs root and a writable filesystem; the API has neither,
and should not. It runs under `ProtectSystem=strict` with `NoNewPrivileges`,
which makes `apt` impossible from it regardless of sudo — a read-only mount
namespace is inherited by every child. So an install is queued as a task for
the agent on the target machine, including when that machine is the controller
the console runs on: one path, the same on every server, and the control plane
keeps its sandbox. Only the arguments the role descriptor declares are passed.
Deregistering a role removes ODM's record of it and leaves the packages
running — tearing down a live DHCP server should not be one click in a web UI.

## Deliberate implementation choices

Two mechanisms differ from the letter of CLAUDE.md §5.1, in both cases
because the specified route needs a schema extension or a file share ODM
cannot reach, and the chosen route is an equally standard Debian mechanism:

- **Sudo scope** is written by the agent to `/etc/sudoers.d`, validated with
  `visudo`, rather than as `sudoRole` LDAP objects read by SSSD. `sudoRole`
  needs the sudo schema loaded into Samba's directory; the agent route works
  on a stock domain and is naturally machine-scoped, because each machine
  receives its own resolved policy.
- **HBAC rules** (host-based access control) are enforced by the agent through
  `pam_access` and an sshd drop-in rather than by SSSD's
  `ad_gpo_access_control` reading GPOs from SYSVOL. Deny-overrides-allow
  semantics are preserved, and local administrators are never locked out.

Both are agent-side, so switching to the SSSD-native path later changes the
appliers, not the policy model or the UI.

DNS is managed through `samba-tool dns` rather than by writing dnsRecord
blobs into the directory: the binary record format is exactly the kind of
protocol code §6 rules out reimplementing, and samba-tool is the supported
interface to the same data. Every argument is validated against a strict
pattern and passed as an argv element, never through a shell. DNS management
therefore needs the API to run on a domain controller; the UI says so
plainly when it does not.

Administrative templates are parsed from the vendor's own ADMX and ADML, and
the settings UI is generated from that schema rather than hand-written per
setting. Because Debian clients have no registry, ODM maps the registry keys
it recognises — Chrome, Chromium and Firefox — onto each browser's native
managed-policy document, and reports any other template setting as having no
Debian equivalent instead of accepting it and doing nothing.

Group policy objects live in PostgreSQL, since most ODM settings (systemd
units, drive maps, Linux sudo scope) have no native GPO representation. When
`ODM_SYSVOL_PATH` is set — that is, when the API runs on a domain controller
— the *structure* is mirrored into LDAP and SYSVOL (a groupPolicyContainer
per GPO, `gPLink` on each linked container, `gPOptions` for block
inheritance) so GPMC and RSAT see the same tree. The mirror is
all-or-nothing: a groupPolicyContainer whose SYSVOL path does not exist is
worse than no object at all.
