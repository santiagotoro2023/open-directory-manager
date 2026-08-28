# odm-agent

Single static Go binary that runs on every domain-joined Debian machine.

It authenticates to the ODM API with SPNEGO using the machine keytab domain
join already installed, pulls its effective policy, applies it, and reports
per-setting Resultant Set of Policy back.

Precedence — OU inheritance, block inheritance, enforced links, multiple
linked GPOs, security-group filtering, item-level targeting — is resolved by
the API, never here (CLAUDE.md §5.2). The agent applies what it is handed.

## Commands

```
odm-agent apply [--force] [--user NAME]   fetch and apply now (--force = gpupdate /force)
odm-agent daemon                          apply on the policy's refresh interval
odm-agent --version
```

`--root DIR` writes beneath a directory instead of `/`; it exists so the
appliers can be exercised without touching a live host, and the test suite
uses it throughout.

## What each setting turns into

| Setting | Mechanism |
|---|---|
| File deployment | Atomic write with mode/owner/group |
| Scripts | `odm-scripts.service` for startup/shutdown, a `pam_exec` hook for logon/logoff |
| systemd units | `systemctl enable/disable/mask/start/stop` |
| Scheduled tasks | `/etc/cron.d/odm-*` |
| Software deployment | `apt-get` install, upgrade or remove, batched per run |
| Trusted certificates | `/usr/local/share/ca-certificates`, then `update-ca-certificates` |
| Firewall | A dedicated `inet odm` nftables table plus `odm-firewall.service` |
| Drive maps | `.mount`/`.automount` units machine-wide, pam_mount per user or group — always `cifs` with `sec=krb5`, never a stored credential |
| Browser policy | Chromium `policies/managed/odm.json`, Firefox `policies.json` |
| Desktop background | dconf system database plus locks, then `dconf update` |
| Sudo rules | `/etc/sudoers.d/odm-*`, validated with `visudo -cf` before install |
| HBAC rules | `pam_access` block in `/etc/security/access.conf` plus an sshd drop-in; deny overrides allow |

A PAM session hook is installed on every machine: at login it runs any logon
scripts and, in the background behind a timeout, applies the logging-on
user's own policy — per-user drive maps and desktop background — so a slow
control plane can never hold up a login. A user document drives only the
user-scoped appliers; logging in cannot mask a systemd unit, write a sudoers
rule or rewrite the firewall.

Every file the agent owns carries a managed header, and the paths it wrote
are recorded in `/var/lib/odm/managed-state.json` so that removing a setting
from a GPO removes the file it produced on the next run.

## Safety properties

- An HBAC allow-list always keeps `root` and local administrators, so a
  policy mistake cannot strand a machine.
- A sudoers fragment that fails `visudo` is never installed.
- One failing applier does not stop the others; each reports its own status.
- Writes are atomic, so a reader never sees a half-written policy file.

## Development

```
go vet ./...
go test ./...
go build -o odm-agent .
```

The tests use a temporary root and a fake command runner, so no systemd,
nftables or sshd is needed to run them.
