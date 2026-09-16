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
- **Any setting that can affect whether a machine boots (kernel command
  line, initramfs contents, boot loader configuration, disk/filesystem
  layout) is held to a stricter standard than "the underlying tool
  returned success," because RSoP reporting is worthless on a machine that
  cannot boot far enough to send one.** Two real incidents in a row (see
  Wiki → Troubleshooting → Boot splash) made this concrete, back to back:
  first, a graphical boot splash setting widened an initramfs module list
  fleet-wide, exhausted a small `/boot` partition on some machines, and
  left them permanently unable to mount root; the fix for that replaced the
  wide setting with a narrow, hardware-*detected* module list and a
  structural validity check (the new initramfs archive lists cleanly) —
  and the very next rollout bricked a machine anyway, because the detected
  list covered display drivers but nothing about storage, and a clean,
  valid archive that is missing the one driver a specific machine's root
  filesystem needs is still an archive that cannot boot. Neither incident
  was a fluke; both were the same mistake — trusting a tool, or a "smart"
  per-machine detection step, to get something right that has no room to
  be wrong — aimed at two different settings. For any applier in this
  category:
  - Validate whatever it produced (e.g. an initramfs actually lists its
    contents cleanly) before treating the change as applied — a tool's
    zero exit status is not sufficient proof for something this
    unrecoverable. Understand this as a weak, structural check only
    (catches corruption, not "will this specific machine actually boot")
    — treat it as one layer, never as sufficient on its own.
  - Back up the artifact that must keep working on the very next boot
    before touching it, and restore that backup automatically the moment
    validation fails, reporting the setting as failed rather than applied.
  - Check for resource exhaustion (disk space, in particular) before
    starting a rebuild rather than discovering it mid-write.
  - Prefer a generous, unconditional, hand-picked list of what a category
    of hardware might need over a "detect what this machine has and
    include only that" step, for anything the machine must have to boot at
    all. Detection can be wrong in ways nobody anticipated (a storage
    stack of LVM-on-top-of-a-SCSI-emulated-disk needing both the disk
    driver and the transport driver, neither the obviously "detected" one);
    a module nobody's machine needs costs a few tens of kilobytes and is
    skipped harmlessly, so err toward including more, not toward guessing
    precisely.
  - Never let this category of setting remove the operator's own way back.
    A machine is not actually protected by a validation step that might
    itself be wrong — it is protected by GRUB's menu staying reachable (a
    boot timeout must never be driven all the way to zero, even for a
    "seamless" experience — a couple of seconds' delay is invisible to
    everyone who does not need it, and it is the only thing that helps the
    one machine that does) and by at least one other complete, working
    kernel remaining on disk to select from that menu if the new one fails
    for a reason nothing here caught. No static check can prove a rebuilt
    boot artifact will actually boot on every real machine — a genuine,
    reachable fallback is the part of this that is actually guaranteed,
    not a nice-to-have layered on top of "we validated it."
  None of this is specific to the boot splash — any future applier that
  touches this category of configuration must carry all of these
  properties from its first commit, not as a follow-up once it breaks a
  fleet.
- **A generous module list is worthless if the tool copying modules into
  the initramfs cannot see them.** A third round of the same incident
  above turned out not to be about which modules were listed at all:
  `odm-agent.service` deliberately sets `ProtectKernelModules=true` (it
  also removes `CAP_SYS_MODULE` from a process that has no business loading
  a kernel module directly), and that hardening is inherited by anything
  the agent spawns as a direct child — including `update-initramfs`,
  triggered here via `plymouth-set-default-theme -R`. That hid
  `/usr/lib/modules` from the rebuild, so every module this file correctly
  listed was silently absent from the result regardless, on every rebuild
  the agent itself triggered — while a manual rebuild from rescue media,
  outside any such sandbox, always worked, which is what made this look
  like a hardware-specific problem rather than a process one for as long as
  it did. `lsinitramfs` still reported the result as a structurally valid
  archive throughout, since an archive missing files it should have had is
  not itself a corrupt one — confirming again that structural validation
  (required above) is necessary and never sufficient on its own. This
  project already has the right tool for this
  (`Unsandboxed` in `agent/internal/apply/env.go`, used for package
  installs since an early incident with the same shape — see its own
  comment) — the mistake was not building a second sandbox-escape
  mechanism, it was a new call site not using the existing one. Any command
  this agent runs that needs a capability its own hardening
  (`deploy/odm-agent.service`) deliberately removes — loading a
  kernel module, an install script that assumes ordinary root, anything in
  that shape — must go through `Unsandboxed`, not `env.Run.Run` directly; this is not
  obvious from reading the failing code in isolation, only from reading the
  service file's own hardening (`deploy/odm-agent.service`) alongside it.
- **Prefer a generic, in-kernel mechanism over asking a specific vendor's
  driver to do something early, even when the vendor's own documentation
  says to.** A fourth round of the boot-splash incident above: two versions
  in a row added an NVIDIA-specific kernel parameter
  (`nvidia-drm.modeset=1`, then `nvidia_drm.fbdev=1` alongside it) to give
  the proprietary driver early kernel mode setting, on the reasoning —
  correct in general, and the standard, documented way to do this — that
  Plymouth needed a driver to have taken over the display before it could
  draw anything. Confirmed live, on real NVIDIA hardware, that this was
  the wrong fix for the wrong problem: with both parameters verified
  active on the actual running kernel, Plymouth's DRM renderer still drew
  nothing at all, because of a real, reproducible kernel `WARN_ON` inside
  NVIDIA's own compiled `nvidia_drm.ko`, hit during the ordinary
  drop-master handoff to the login manager — confirmed to have no module
  parameter (`/sys/module/nvidia_drm/parameters/` only exposes `modeset`
  and `fbdev`, checked directly against the running module rather than
  assumed) and no different driver version available to work around. The
  actual fix needed no vendor driver involved at all:
  `GRUB_GFXPAYLOAD_LINUX=keep` (already present, for a different reason —
  closing the GRUB-to-kernel graphics-mode flash) is sufficient by itself,
  because the kernel's own generic, in-tree `simpledrm`/`efifb` driver
  picks up whatever mode GRUB already negotiated via UEFI and exposes it
  as a plain DRM device Plymouth can draw onto directly, on any vendor's
  hardware, before that vendor's own driver ever loads. The real GPU
  driver still takes over normally once the desktop session itself
  starts — early boot and the desktop session are separate, sequential
  owners of the display, and only the desktop session actually needs the
  real driver loaded. Before reaching for a vendor-specific early-KMS
  parameter for anything boot-critical, check whether the kernel's own
  generic mechanism already covers the actual need — a proprietary,
  out-of-tree driver is exactly the code this project has the least
  ability to debug or work around when it has its own bug, which is a
  reason to avoid depending on it early, not a reason to reach for its
  specific flags first.
  **Addendum, same incident, same day**: the generic-only fix above was
  then tried live and *also* rendered nothing on the same hardware —
  `nvidia-drm.modeset=1` alone, tried before `fbdev=1` existed and before
  an unrelated sandboxing bug in this project's own agent was fixed, is
  the one combination ever actually seen to render something. It is back,
  without `fbdev=1`, on that evidence. This is a provisional, evidence-led
  reversal, not a retraction of the principle above: the actual lesson is
  to keep changing exactly one variable at a time against real hardware
  and trust what is observed over what is documented as standard practice,
  in either direction. If `modeset=1` alone is later confirmed not to
  render either, the honest conclusion is that this specific driver
  version's DRM implementation cannot render a Plymouth theme on this
  hardware at all, and the setting should stay off for machines with it
  rather than clock up a fifth guess.
- **When several consecutive fixes to the same symptom each change a
  different variable and each change nothing, stop tuning that variable
  and go looking for the one that is constant across all of them.** The
  boot-splash setting rendered nothing across four attempts —
  `modeset=1`, `modeset=1 + fbdev=1`, neither, `modeset=1` again — and the
  parameter under test was never the cause. The constant was that this
  file's own unconditional display-driver list named `nouveau`, which was
  therefore force-loaded into the initramfs of a machine running the
  proprietary NVIDIA driver, on every one of those boots. The two drivers
  claim the same hardware; `nouveau`'s probe calls
  `drm_aperture_remove_conflicting_pci_framebuffers()` before anything
  else, evicting `simpledrm`/`efifb` from the display, and then fails on
  hardware it has no firmware for — leaving nothing for Plymouth to draw
  on no matter how its parameters were set. Two things this project got
  wrong made it invisible:
  - A `blacklist` line in `/etc/modprobe.d` does **not** stop this. A
    blacklist only suppresses *automatic* loading by modalias;
    initramfs-tools runs an explicit `modprobe` for every name in
    `/etc/initramfs-tools/modules`, and an explicit modprobe ignores the
    blacklist. The name must not be in that file at all.
  - Every version of this code only ever *appended* to that file. A module
    name written by an older agent therefore survives every later rebuild
    for the life of the machine unless something deletes it, so removing a
    name from a list in this source file does nothing for any machine that
    already has it. Anything that writes a name into a persistent list on
    a machine needs the matching removal path written at the same time, or
    it cannot be taken back.
- **A file the agent writes only when it needs changing is a file the
  agent deletes on the pass after.** Ownership of a path is claimed by the
  act of writing it, and the prune step at the end of every apply removes
  whatever the previous pass claimed and this one did not. For an applier
  that compares first and returns early when the contents are already
  right, "correct already" and "no longer wanted" become the same thing,
  and the second consecutive apply of an *unchanged* policy destroys the
  first one's work. Found live, after nine releases of it going unnoticed:
  one apply reported success while removing
  `/etc/plymouth/plymouthd.conf`, `/etc/initramfs-tools/modules` and the
  machine's whole storage and input driver list — and the same mechanism
  had `restoreInitrd` claiming `/boot/initrd.img-<version>`, so a rebuild
  that failed validation and was correctly rolled back left the *next*
  routine fifteen-minute poll deleting the running kernel's initramfs.
  Two rules come out of it:
  - An applier that skips its write must still say the path is wanted
    (`Env.Keep`). Not writing is not the same as not wanting.
  - Some paths must never be prunable at all, whatever the state file
    says: files the system owns and ODM only keeps lines inside, the
    rollback copy taken before a risky change, and anything under `/boot`.
    Enforce that in one predicate consulted by *both* the claiming side
    and the pruning side — the pruning side matters on its own, because a
    machine upgrading from a version that did claim these carries the
    stale claim in the state file already on its disk, and that alone is
    enough to delete the file once, on the very upgrade that fixes it.
- **A new agent version must apply once on its own, or its fixes never
  run.** The apply that carries out a self-update executes under the
  binary being replaced; the new binary then starts, finds the policy
  serial unchanged and nothing newer on offer, and prints "policy
  unchanged" on every poll until somebody happens to edit a policy
  object. 0.10.17 shipped a fix to a file its predecessor had written
  wrongly, was installed fleet-wide within a minute, and corrected that
  file on no machine at all. The serial file now records which agent
  version wrote it (`lastSerial` in `agent/main.go`); a serial recorded by
  any other version reads as no serial. Anything else that gates work on
  "has this changed since last time" must include the agent's own version
  in what "last time" means.
- **A shell script this agent writes onto a machine is tested by running
  it, not by reading it.** The graphical second-factor walkthrough shipped
  with its attempt loop reading `while [ "" -le 3 ]` — a `$ATTEMPT` eaten
  by an edit made through a shell one-liner, whose own quoting swallowed
  the variable — and `test(1)` refuses an empty operand, so the loop body
  never ran: no window, no call to the console, and every graphical
  sign-in went straight to "Signing out". Nothing in the tree could have
  caught it, because every test of that script asserted that certain
  substrings were present and none ever executed it. Scripts the agent
  generates live inside Go string literals, where `$name` means nothing to
  the compiler and everything to `/bin/sh`; edit them with a tool that
  does not interpret `$` (never through `perl -pi`/`sed` on a shell
  command line without reading the result back), and give each one a test
  that at least runs `sh -n` over the written file and asserts against
  `[ "" ` — the fingerprint of a variable that went missing.
- **Ask the component itself before theorising about it.** The boot splash
  failed to render across six attempts, each with a different explanation
  — kernel parameters, module lists, driver versions, a theme script, a
  kernel `WARN_ON` — and every one of them was wrong. Plymouth has a debug
  log (`plymouth.debug=file:/path` on the kernel command line, or
  `plymouth.debug` alone) that states plainly which renderer plugin it
  loaded, which device nodes it opened, what it found on them and why it
  rejected each one. One capture of it ended the whole thing in a single
  read: Plymouth was offered `/dev/fb0` at 7.3s and discarded it with
  "ignoring since we only handle subsystem graphics devices after
  timeout", spent its attempt on nvidia's *render node*
  (`/dev/dri/renderD128`, which has no modesetting and can only fail), and
  lost `/dev/fb0` for good at 10.5s when nvidia took the display. Nothing
  about any of that was guessable from the outside, and all of it was one
  command away for hours. When a component is not doing what it should,
  find out whether it can be asked directly before reasoning about what it
  might be doing.
  - The setting itself is worth knowing: Plymouth claims a real DRM device
    the moment it sees one, but will not claim a legacy `/dev/fb`
    framebuffer or a text console until `DeviceTimeout` (default eight
    seconds) has elapsed, so that a slow-probing GPU driver does not lose
    to a fallback. On a machine whose *only* early graphics device is a
    legacy framebuffer — no `simpledrm`, proprietary driver not in the
    initramfs — that rule means the splash has no device for the entire
    window it exists to fill.
  - **And "ask the component" includes reading its source for what a
    value means before writing that value.** The fix for the above was
    `DeviceTimeout=0`, on the reasoning — stated in a code comment as
    fact — that zero would mean "use what you have". It was never
    checked. Plymouth arms that wait with
    `ply_event_loop_watch_for_timeout`, whose first lines are
    `assert (seconds > 0.0)`; zero killed `plymouthd` a millisecond after
    it started, on every boot, for two releases, and the text console
    that resulted looked exactly like the failure it was meant to fix. It
    was found by installing `systemd-coredump` and reading the backtrace,
    which took one reboot; the source that would have prevented it was
    one `curl` away. When assigning a value to a setting of a component
    this project does not own, especially an edge value like zero, find
    the line of its code that consumes it. A value that is not documented
    is not therefore free to mean what would be convenient.
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
