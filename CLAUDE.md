# Open Directory Manager (ODM) — Build Specification

**Read this entire document before writing any code.** This is the authoritative
spec for a production-grade, open-source Linux replacement for the core of
Windows Active Directory. Every requirement marked **MUST** is non-negotiable
for v1 — do not defer any of them to a "future version." Where a phased build
order is given, it is for sequencing only; every phase ships in v1.

This project has no ties to any individual or company. Do not put any
personal name, employer name, or private domain anywhere in code, comments,
commit messages, config examples, tests, or docs. Use generic placeholders:
maintainer `Open Directory Manager Contributors <hello@example.org>`, example
domain `example.org` / `corp.example.internal`, example org unit `Example
Corp`. License: `AGPL-3.0-or-later` unless a `LICENSE` file already exists in
the repo saying otherwise.

---

## 1. Philosophy

- **Windows-admin-familiar, not Windows-admin-hand-held.** Anyone who has run
  ADUC, GPMC, or the DHCP/DNS MMC snap-ins should recognize the terminology,
  the object model, and the navigation structure within minutes. Use real AD
  terms: Organizational Unit, Group Policy Object, Security Group,
  Distinguished Name, Sudo Rule, HBAC, not invented synonyms.
- **Clean, dense, uncluttered.** No onboarding wizards that over-explain, no
  inline tooltips justifying why a setting exists, no marketing copy in the
  product. Assume the operator reads the docs (built separately, later). The
  UI's job is to be fast to navigate and impossible to get lost in — closer to
  FreeIPA's or a modern SaaS admin console's information density than to a
  consumer app.
- **Production-grade from commit one.** This will run in real environments
  managing real credentials and real access control. Treat every component —
  including the first commit — as if it will be audited and attacked. No
  "we'll harden it later."
- **Reuse audited trust boundaries; write new code only for orchestration and
  UI.** Directory, Kerberos, DNS, and GPO storage ride on Samba AD DC — a
  mature, wire-compatible, actively-maintained implementation. ODM's own new
  code (API, agent, policy compiler) is deliberately kept out of the crypto
  and directory-protocol path wherever a proven component already does that
  job correctly.

---

## 2. Locked architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| Directory/Kerberos/DNS backend | **Samba Active Directory DC** | Real AD wire protocol, real SYSVOL, real ADMX/ADML template support, future Windows-client join stays possible without a rearchitecture |
| Control-plane API | **Python (FastAPI)** | Async, typed, fast to extend, matches the operator's existing scripting background |
| Client-side policy agent | **Go**, single static binary | Low resource footprint on Debian clients/servers, trivial to distribute as one file + systemd unit, no runtime/interpreter dependency on target machines |
| Web UI | **React SPA** (TypeScript), talking only to the ODM API — never directly to LDAP/Kerberos | Keeps all directory access behind one auditable, RBAC-enforcing layer |
| DHCP engine | **ISC Kea** (`kea-dhcp4`, `kea-dhcp-ddns`), driven via its Control Agent HTTP API | Modern, actively maintained, native REST-ish control, HA/failover pairing, dynamic-DNS hook straight into Samba's AD-integrated zones |
| ODM's own metadata store | **PostgreSQL** | Audit log, RBAC assignments, role registry, recycle-bin snapshots, GPO-link cache/precedence resolution, DHCP scope cache — never the source of truth for directory objects themselves, which always live in Samba's LDAP |
| Machine/agent authentication | **Kerberos, via the machine's existing domain-join keytab** (GSSAPI to the API) | No second credential system to leak; a domain-joined machine already has a computer account and keytab from `net ads join` / `realmd` |
| Target OS for v1 | **Debian 12 (bookworm) and Debian 13 (trixie), both supported from v1** — domain controllers, domain members, and desktop clients | Stated requirement |
| Windows client support | Architected for, not required to function in v1 (Samba AD DC keeps this open without rework) | Per requirements discussion |

---

## 3. Non-negotiable v1 feature list (traced to source requirements)

Every item below **MUST** work end-to-end in v1. Nothing here is a stretch
goal.

1. Login system for the web UI that **only** authenticates members of a
   configurable "Domain Admins"-equivalent group (Kerberos/LDAP bind against
   Samba, group-membership check before a session is issued — no separate
   ODM user database, no local password store).
2. Full AD-style domain structure: forest/domain concept, Organizational
   Units, nested OUs, computer objects, user objects, security groups
   (global/domain-local semantics), distribution-style groups if useful,
   built-in containers (Users, Computers, Domain Controllers).
3. User, group, and computer object CRUD through the web UI — create,
   read, update, delete, move between OUs, bulk operations (bulk create from
   CSV, bulk group membership edit).
4. GPO-equivalent policy objects: create, edit, **link to one or more OUs**,
   set link order/precedence, block inheritance per OU, enforce
   ("no override") per link, item-level targeting (by OS, hostname pattern,
   security group, IP range) equivalent to WMI filtering.
5. Policy settings coverage — every category below must be settable through
   the web UI and actually enforced by the client agent on Debian targets:
   - Network share / drive mapping, **assignable per logged-on user or
     group**, auto-mounted at login without manual action.
   - Browser policy (Firefox and Chromium/Chrome at minimum): homepage,
     bookmarks, extension allow/block lists, proxy settings, security
     policies — written to the browsers' native managed-policy locations.
   - Desktop background/wallpaper, per user or group.
   - Sudo command scope: which users/groups may run which commands (or
     full sudo) — **scoped to specific machines or machine groups**, not
     just domain-wide.
   - Logon rights: which users/groups may log on **locally, over SSH, or
     over RDP-equivalent** at which machines or machine groups (deny
     overrides allow, matching AD semantics).
   - File deployment (push a file to a path on target machines).
   - Scripts (startup/shutdown, logon/logoff).
   - Scheduled tasks/cron entries pushed centrally.
   - systemd unit enable/disable/mask.
   - Basic firewall rules.
6. **ADMX/ADML import**: administrators can upload vendor-provided ADMX +
   ADML files (Chrome, Firefox, etc. already ship these); ODM parses them and
   renders a settings UI dynamically from the schema, storing resulting
   values as policy the agent can apply. This is real XML parsing work, not
   guesswork — scope it as a genuine parser, not a stub.
7. DNS management in the UI: zones, records, dynamic-update status — backed
   directly by Samba's integrated DNS (no separate DNS product).
8. DHCP management in the UI: scopes, pools, reservations, options,
   lease view, **DHCP failover/HA pairing between two nodes**, **DHCP↔DNS
   dynamic-update replication** so DHCP-assigned hosts appear in DNS
   automatically.
9. Deleted-object retention and restore ("recycle bin"): every delete
   through the API is a soft-delete — full object state (including group
   memberships/links) is snapshotted before the underlying directory delete,
   restorable from the UI within a configurable retention window (default
   180 days), permanently purged after.
10. Role-based server extensibility: a fresh ODM install brings up AD + GPO
    + DNS only. DHCP, file-server, and any future role must be addable
    afterward from the UI/CLI without redeploying the base system — a real
    plugin/role framework, not a manual install guide.
11. Full audit trail: every write (object created/changed/deleted/moved,
    policy changed/linked, DHCP scope changed, role installed) is logged
    with actor, timestamp, before/after diff, viewable and filterable in the
    UI.

---

## 4. Recommended additions (build the data model for these now; UI/CLI can
   follow once the above is solid — do not let these block v1, but do not
   architect them out either)

- **Delegated administration**: an RBAC layer beyond "full Domain Admin" —
  scoped roles assignable per-OU (e.g. "can manage users under OU=Helpdesk
  but nothing else"). Model this in the RBAC tables from day one even if the
  UI only exposes it partially at first.
- **One-click domain backup/restore**, wrapping `samba-tool domain backup`,
  surfaced in the UI with scheduled backups and a documented restore drill.
- **Multi-DC replication topology view** — list DCs, replication status,
  force replication, since Samba supports multi-master replication and an
  operator should never have to drop to `samba-tool drs` blind.
- **PKI/CA role** for certificate autoenrollment, mirroring what AD CS does —
  natural next role after DHCP/file-server.
- **Software-deployment role**: push apt package installs/updates to target
  machines or groups on a schedule, the closest Linux analogue to AD's
  software-installation GPO.
- **Client enrollment / PXE role**: unattended Debian install + auto-join,
  for zero-touch provisioning.
- **Health/monitoring dashboard**: DC status, DHCP scope utilization,
  replication lag, agent check-in freshness.

---

## 5. Component design detail

### 5.1 Identity/directory layer
- Samba AD DC as the domain's first DC. `samba-tool domain provision` for
  bring-up; ODM's setup flow wraps this, not replaces it.
- Sudo rules stored as standard `sudoRole` LDAP objects (the same schema
  FreeIPA and Univention use) so `sssd` clients read them natively via
  `sudo_provider = ldap` — no custom sudo distribution mechanism needed on
  top of what SSSD already does well.
- Logon-rights enforcement on Debian clients via SSSD's native
  `ad_gpo_access_control` — since the backend is genuinely AD-wire-compatible
  Samba, this works without ODM reinventing it; ODM's job is only to write
  the correct GPO objects into SYSVOL and give the operator a UI for it.

### 5.2 Policy engine
- Policy objects live partly in Samba SYSVOL (so they remain interoperable
  with real GPO tooling / RSAT if ever pointed at this domain) and partly in
  ODM's own Postgres store for ODM-specific setting types that have no
  native AD equivalent (e.g. systemd unit toggles).
- The **API**, not the agent, resolves final precedence (OU inheritance,
  block-inheritance, enforced links, multiple linked GPOs, security-group
  filtering, item-level targeting) into one flattened "effective policy"
  document per computer/user pair. The agent only applies what it's handed —
  keep precedence logic centralized and testable, not duplicated on every
  client.
- Agent → API auth: GSSAPI using the machine's existing domain keytab.
  Agent polls on an interval (default 15 min, configurable via policy
  itself) and supports on-demand refresh (`odm-agent apply --force`,
  equivalent to `gpupdate /force`).
- Agent reports back a Resultant-Set-of-Policy status per applied setting
  (success/fail/skipped + reason) so RSoP is visible from the UI, not just
  inferred.
- Concrete per-category implementation:
  - **Drive maps**: agent renders a `systemd` `.mount`/`.automount` unit (or
    an `autofs` map entry) per resolved share, using `cifs` with
    `sec=krb5` so no credentials are ever stored on the client — SSO via the
    user's existing Kerberos ticket.
  - **Browser policy**: write Chromium managed-policy JSON to
    `/etc/opt/chrome/policies/managed/`, Firefox `policies.json` to
    `/etc/firefox/policies/` — both are real, documented enterprise-policy
    mechanisms, not invented ones.
  - **Wallpaper/background**: dconf profile + `dconf update` for GNOME
    targets (matches the operator's existing GNOME/dconf-based lab
    experience); design the applier interface so KDE/other DE support is a
    later plugin, not a rewrite.
  - **Sudo/logon scope**: written as LDAP `sudoRole` objects and SSSD/GPO
    logon-rights settings per §5.1, not local file mangling by the agent.
- ADMX/ADML importer: a real parser (ADMX/ADML are documented XML schemas)
  that produces a typed setting definition the UI renders as form controls,
  and that the policy compiler understands when building effective policy.

### 5.3 Recycle bin
- Do not depend on Samba's native tombstone/Recycle Bin fidelity being
  complete. Implement retention at the API layer: DELETE requests trigger a
  full-object + linked-attribute snapshot into Postgres before the
  underlying Samba delete runs; restore reverses both the snapshot and the
  group-membership links; a scheduled job purges past the retention window.

### 5.4 DHCP/DNS
- Kea Control Agent as the only thing ODM's API talks to for DHCP — never
  hand-edit `kea-dhcp4.conf` outside of ODM once adopted.
- `kea-dhcp-ddns` configured to push updates into Samba's AD-integrated DNS
  zones via GSS-TSIG, so DHCP leases and DNS stay in sync automatically —
  this is the "DHCP and DNS replication" requirement, implemented with
  existing, documented mechanisms rather than custom sync code.
- DHCP HA/failover: two Kea nodes in an HA pair from the setup flow for the
  DHCP role, not left as a single point of failure.

### 5.5 Roles/extensibility framework
- A role is: a Debian package/service to install and configure on a target
  node, a registration step that tells the ODM control plane the role
  exists and where, and a UI module that lights up once the role is
  present. Core role (AD + GPO + DNS) is always on. DHCP and file-server
  ship as the first two installable roles in v1; the framework itself must
  make adding CA/software-deployment/PXE roles later a matter of writing a
  new role plugin, not touching the core.

### 5.6 Domain-join client (CLI)
`odm-client-install`, modelled directly on `ipa-client-install` — a single
command with flags for non-interactive use (`--domain`, `--server`, `--otp` /
`--admin-user`) and interactive prompts otherwise. It handles: discovering
the ODM domain via DNS SRV records, authenticating a join credential/OTP,
configuring `krb5.conf` and `sssd.conf`, performing the actual domain join
(`net ads join` equivalent against the Samba AD DC), registering the
machine's computer object, installing the machine keytab, fetching the
console's certificate from SYSVOL over Kerberos, and installing + enabling
the Go policy agent as a systemd service.

There is deliberately no graphical installer. A desktop user opens a
terminal and runs the same one line a scripted install does; one code path
means one thing to test, one shape of failure to report, and no missing
dependency chain of graphics libraries to keep working.

---

## 6. Security requirements (apply everywhere, not just where reasonable)

- TLS everywhere — no plaintext HTTP for the UI/API, no plaintext LDAP.
- No custom crypto, no custom Kerberos/LDAP implementation — always the
  system libraries/Samba/MIT Kerberos.
- Principle of least privilege for every service account the API and agent
  use against Samba/Kea — never a full Domain Admin bind for routine reads.
- All destructive/privileged API actions require the caller to be in the
  Domain-Admins-equivalent group (or a delegated-admin scope once that
  ships), checked server-side on every request, never trusted from the
  client.
- CSRF protection and hardened session handling on the web UI; rate-limit
  and lock out repeated failed logins.
- Input validation on every API boundary — this is an identity/access
  system, injection or object-confusion bugs here are critical-severity.
- Dependency scanning and pinned versions in CI from the first commit.
- Full audit logging (see §3.11) doubles as your intrusion-detection
  surface — treat it as a security control, not just a UX nicety.
- Secrets (keytabs, DB credentials, Kea API auth) via a secrets file with
  restrictive permissions or a secrets manager — never in git, never in
  plain config committed to the repo.

---

## 7. Suggested build order (sequencing only — all phases ship in v1)

1. **Foundation**: Samba AD DC provisioning automation, Postgres schema for
   ODM metadata, FastAPI skeleton with Kerberos auth + domain-admin gate,
   React shell with auth flow.
2. **Core directory management**: Users/Groups/Computers/OUs CRUD in the UI,
   audit logging wired in from this point forward (not bolted on later).
3. **Policy engine core**: GPO object model, OU linking/precedence
   resolution in the API, Go agent skeleton with Kerberos auth to the API
   and a pull/apply/report loop; ship the file-deployment, script, and
   systemd-unit appliers first as the simplest correctness proof.
4. **The harder appliers**: drive maps, browser policy, wallpaper, sudo/logon
   scope, cron.
5. **ADMX/ADML importer** and dynamic settings UI.
6. **DHCP role via Kea**, DHCP↔DNS DDNS sync, HA pairing.
7. **Recycle bin**, then **roles/extensibility framework** generalized from
   how the DHCP role was bolted on.
8. **Hardening pass + recommended additions** (delegated admin, backup/
   restore, replication topology view) before calling v1 done.

---

## 8. Branding

A logo has already been generated and must be carried into the repo from
the first commit, not designed later. Three SVGs plus a usage guide are
provided alongside this spec under `branding/`:

- `odm-mark.svg` — icon-only mark (rounded-square badge, a small
  hierarchy/org-chart glyph in white on indigo `#4F46E5`). Favicon, browser
  tab, native app window/taskbar icon.
- `odm-logo-compact.svg` — mark + "ODM" + small "OPEN DIRECTORY MANAGER"
  caption. Web UI top nav bar, join app title bar.
- `odm-logo-full.svg` — mark + full "Open Directory Manager" wordmark. Web
  UI login screen, join app welcome screen, README header, about dialogs.
- `BRAND.md` — palette, clear space, minimum sizes, typography stack.

Copy these files verbatim into the repo at `branding/` (or `assets/brand/`)
in the very first commit. **Rule: the mark never appears alone on a primary
surface — login screen, nav bar, join-app header — without the brand name
or "ODM" shorthand rendered as text next to it.** Icon-only use is reserved
for favicons and OS-level app icons where a wordmark can't render legibly.
If the mark needs to be regenerated at any point (new sizes, dark-mode
variant, etc.), keep the same glyph, palette, and composition — don't
silently drift the brand.

## 9. UI design system

FreeIPA-inspired information density and structure; a sleeker, more modern
visual language on top of it.

- **Surface**: white/near-white backgrounds (`#FFFFFF` primary,
  `#F8FAFC` for recessed panels/sidebars), not a dark theme by default.
- **Accent**: indigo `#4F46E5` from the brand palette — primary buttons,
  active nav item, links, focus rings. Don't introduce a second accent
  color without reason.
- **Corners**: consistently rounded — 8px on inputs/buttons/small cards,
  12–16px on larger containers/modals. Rounding should read as "modern
  SaaS console," not playful/consumer.
- **Icons**: adopt a single existing, permissively-licensed, actively
  maintained SVG icon set (e.g. Lucide or Heroicons) for all in-app
  iconography — sidebar nav, object-type icons (user/group/computer/OU/
  GPO/DHCP scope/DNS zone), action icons. Don't hand-draw a bespoke icon
  per feature; consistency across hundreds of icons matters more than
  originality here, and a maintained set stays visually coherent as the
  product grows.
- **Layout**: responsive from a single desktop-first breakpoint down to
  tablet width at minimum (this is an admin console — phone support is not
  a priority, but the layout must not break on a laptop screen or a
  slightly narrower external monitor).
- **Density and tone**: dense data tables (users, computers, GPO links)
  over card grids where the content is tabular by nature. No inline
  explanatory tooltips justifying *why* a setting exists — labels should be
  the real AD/GPO terminology, self-evident to anyone who's used ADUC/GPMC,
  with fuller explanation left to external docs.
- **Accessibility**: meet WCAG AA contrast on all text/background pairs
  given the palette above; every icon-only control needs an accessible
  label even if it has no visible text caption.

---

## 10. Open items for the maintainer to decide during the build

- Exact retention window default for the recycle bin.
- License file wording beyond the AGPL-3.0-or-later default above.
