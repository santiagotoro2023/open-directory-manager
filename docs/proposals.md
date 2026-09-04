# Proposals

Work that is **not** built, listed here so it can be signed off before anyone
starts on it. Nothing on this page exists yet; when something ships it leaves
this page and appears in the README and the wiki instead.

Each item says what it is, why it earns its place, and roughly what it costs.
Size is relative: **S** is a day or so, **M** is a few days, **L** is a
feature with its own migration, wiki page and role installer.

---

## New server roles

| # | Role | What it does | Size |
|---|---|---|---|
| 1 | **Monitoring** | Prometheus node exporter pushed to every member by policy, a Prometheus and Grafana pair as a role, and dashboards for the things ODM already knows about — agent check-in freshness, DHCP pool use, replication lag, certificate expiry | L |
| 2 | **Log collection** | `systemd-journal-upload` on members, `systemd-journal-remote` as a role, and a Logs page that searches across the fleet instead of one machine at a time | L |
| 3 | **Mail relay** | Postfix as a smarthost, so the console, certificate expiry warnings and password-expiry notices can actually reach people | M |
| 4 | **Backup target** | A role that is the destination for domain backups and file-share snapshots, with retention and a restore browser, instead of `ODM_BACKUP_DIR` being a local path | L |
| 5 | **Web proxy** | Squid with domain authentication and per-group rules, and the matching browser proxy policy written automatically | L |
| 6 | **Time** | `chrony` as an explicit role serving the domain, with drift on the health dashboard. Kerberos fails hard on clock skew and nothing in ODM currently watches it | S |
| 7 | **Reverse proxy** | HAProxy or nginx fronting the console and any published service, with certificates from the domain authority renewed automatically | M |
| 8 | **Container host** | Register a Podman host as a role and deploy containers by policy the way packages are deployed | L |
| 9 | **NFS shares** | The file-server role currently serves SMB only. NFSv4 with Kerberos for the Linux-only estates that prefer it | M |
| 10 | **Secrets** | A domain secret store — the sealed side of what `local_administrator` already does — so a policy can hand a machine a credential without it being in the policy document | L |

## Directory and policy

| # | Feature | What it does | Size |
|---|---|---|---|
| 11 | **Policy modelling** | Ask "what would this machine get" before linking anything: pick a computer and a user, choose a GPO and a link point, and see the effective policy that would result, next to the one in force now | M |
| 12 | **Policy versioning and rollback** | Every save of a GPO keeps the previous settings document; a diff view, and one button to go back. The recycle bin already proves the pattern | M |
| 13 | **Staged rollout** | A link that reaches 5% of its targets, then 25%, then all, on a schedule, with the agent's own report deciding whether to continue | L |
| 14 | **Scheduled links** | A link that switches itself on at a date and off at another — the maintenance window that currently has to be remembered by a person | S |
| 15 | **Object templates** | "New user like this one": a template holding OU, groups, drive maps and policy links, so onboarding is one form rather than six | M |
| 16 | **Bulk edit from search** | Select rows on the Directory page and change a field, add a group or move them all at once. CSV import exists; the same is not possible on objects that already exist | M |
| 17 | **Dynamic groups** | A group whose membership is a query — everyone in an OU, everyone with a title, every machine running Debian 13 — recomputed on a schedule | M |
| 18 | **Account lifecycle** | An expiry date on an account, warnings before it, and a documented disable-then-delete path that runs itself | M |
| 19 | **Directory search everywhere** | One search box in the top bar reaching objects, GPOs, shares, printers, scopes and wiki pages | S |
| 20 | **Saved views** | Name a filtered list of objects and pin it to the sidebar | S |
| 21 | **Per-OU default policy** | Create an OU and have a chosen set of GPOs linked to it automatically, so a new site is not a checklist | S |
| 22 | **Group Policy comparison** | Diff two GPOs, or the same GPO across two domains, from a configuration export | S |

## Policy settings

| # | Setting | What it does | Size |
|---|---|---|---|
| 23 | **Power and suspend** | Lid, idle and sleep behaviour, which is a real support burden on laptops | S |
| 24 | **Screen lock** | Idle timeout, lock on suspend, and whether it can be turned off | S |
| 25 | **Removable storage** | Block, read-only or allow USB storage, with a group exemption | M |
| 26 | **Proxy** | System proxy settings, currently only reachable through browser policy | S |
| 27 | **NTP servers** | Which time source a machine uses, alongside the time role | S |
| 28 | **Kernel and sysctl** | Named `sysctl` values, and a small set of hardening presets | S |
| 29 | **AppArmor profiles** | Ship and enforce a profile by policy | M |
| 30 | **Auditd rules** | A ruleset per machine group, and the events surfaced in the console | M |
| 31 | **Bookmarks and desktop shortcuts** | Beyond the `.rdp` files that already work: a `.desktop` file for any application or URL, per user or group | S |
| 32 | **Font and theme deployment** | Corporate fonts, GTK theme, icon theme and cursor, as a set | S |
| 33 | **Flatpak and Snap** | Deploy and pin applications from the formats a Debian desktop actually installs from now | M |
| 34 | **Disk encryption status** | Report LUKS state per machine, and escrow the recovery key into the secret store | L |
| 35 | **Login banner and legal notice** | The pre-authentication text a lot of estates are required to show, on the greeter and on SSH | S |

## Remote desktop

| # | Feature | What it does | Size |
|---|---|---|---|
| 36 | **Shared broker state** | Two brokers currently keep separate affinity tables, so a reconnect through the standby does not find the session. A shared table — the Windows connection-broker database, in effect — fixes it | L |
| 37 | **Session control** | Disconnect, sign out, send a message to a session, and shadow one with the user's consent, from the Sessions tab | M |
| 38 | **Drain mode** | Mark a host so it takes no new sessions, wait for it to empty, then patch it | S |
| 39 | **Profile disk management** | See how full each profile disk is, grow one, and reset a broken profile without a shell | M |
| 40 | **Per-collection application list** | More than one published application per collection, each with its own icon and connection file | M |
| 41 | **Web client** | An HTML5 gateway in front of the broker, so a collection is reachable from a browser | L |

## Identity and security

| # | Feature | What it does | Size |
|---|---|---|---|
| 42 | **Second factor for machines** | A second factor at the desktop login, not only at the console, through a PAM module and the enrolment that already exists | L |
| 43 | **Smartcard and FIDO2 login** | Certificate-based sign-in for desktops, issued by the authority ODM already runs | L |
| 44 | **Privileged access** | Time-limited membership of Domain Admins, requested in the console and granted for an hour, with the request in the audit log | L |
| 45 | **Break-glass account** | A sealed emergency account whose use raises an alert, for the day the console cannot authenticate anybody | M |
| 46 | **Sign-in risk** | Impossible-travel and unusual-hour flags from what the audit log already holds | M |
| 47 | **Certificate revocation** | A CRL and OCSP responder. The authority issues and renews but cannot yet revoke | M |
| 48 | **Password breach check** | Reject a new password found in a local breach list, offline | M |
| 49 | **Service account inventory** | Which accounts have SPNs, which have old passwords, which are over-privileged, and what each is actually used for | M |
| 50 | **Kerberos delegation review** | Show every account trusted for delegation, which is the setting most often left behind after a migration | S |
| 51 | **Security baseline report** | One page scoring the domain against a checklist — SMB signing, LDAP channel binding, password policy, stale accounts, unconstrained delegation | M |
| 52 | **Signed policy documents** | The agent verifies a signature on the effective policy before applying it, so a compromised control plane cannot silently push a new sudo rule | L |

## Operations

| # | Feature | What it does | Size |
|---|---|---|---|
| 53 | **Alerting** | Rules on what the health dashboard already computes, delivered by mail or webhook: no backup in N days, a controller not replicating, a certificate expiring, agents gone quiet | M |
| 54 | **Change windows and approvals** | Optionally require a second operator to approve a destructive change, with the request and approval in the audit log | L |
| 55 | **Scheduled tasks in the console** | Run a domain backup, an agent update wave or a report on a schedule, and see the history — the backup loop generalised | M |
| 56 | **Configuration drift** | Compare the running domain against a stored export and list what has changed since. The export already exists | M |
| 57 | **Audit retention and export** | Retention policy for the audit log, and a signed export for whoever asks for one | S |
| 58 | **Fleet command** | Run one command across a selection of machines and see the answers side by side, instead of one machine at a time | M |
| 59 | **Machine grouping by query** | Act on "every Debian 12 machine in Zurich" without making a security group for it | M |
| 60 | **Read-only console mode** | A signed-in session that cannot change anything, for demonstrations and for auditors | S |
| 61 | **Console API tokens** | Scoped, expiring tokens for scripting, instead of a session cookie | M |
| 62 | **Terraform and Ansible provider** | Manage ODM objects from the tooling estates already run, on top of those tokens | L |

## Client and desktop experience

| # | Feature | What it does | Size |
|---|---|---|---|
| 63 | **Self-service portal** | A separate, unprivileged web surface where a person can change their password, see their machines, install approved software and unlock their account | L |
| 64 | **Software catalogue** | An approved list a person can install from without a helpdesk ticket, on top of software deployment | M |
| 65 | **Offline policy** | The agent caches the last effective policy and applies it when the domain is unreachable, so a laptop off the network still behaves | M |
| 66 | **Windows client support** | The backend is wire-compatible already. What is missing is a Windows-side agent for the settings SSSD does not carry, and the testing to claim it | L |
| 67 | **macOS enrolment** | The same question again, one platform further out | L |
| 68 | **Roaming profile size control** | Quotas and a report on which profiles are growing, before a share fills up | M |
| 69 | **First-login setup** | A managed first-run for a new account: wallpaper, dash, drives and printers all in place before the person sees the desktop | S |

## Console

| # | Feature | What it does | Size |
|---|---|---|---|
| 70 | **Dark theme** | The palette is already defined in one place | S |
| 71 | **Keyboard navigation** | A command palette, and shortcuts for the things done twenty times a day | S |
| 72 | **Undo for the last change** | The audit log holds before-and-after state; one button that puts it back | M |
| 73 | **Inline RSoP on the object** | Effective policy on the computer and user object without opening a dialog | S |
| 74 | **Bulk progress** | A single place showing every queued task across the fleet, with what failed and why | M |
| 75 | **Localisation** | The console in more than one language, starting with German | L |
