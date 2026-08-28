# Domain-join client

Two front ends over one shared join library (CLAUDE.md §5.6):

- `join/` — the join sequence, implemented once.
- `cmd/odm-client-install/` — CLI modelled on `ipa-client-install`; flags for
  unattended provisioning (`--domain`, `--server`, `--otp` / `--admin-user`),
  interactive prompts otherwise.
- `cmd/odm-join-gui/` — small Fyne desktop app for joining a Debian desktop
  interactively. Uses `branding/odm-mark.svg` as its window icon and
  `branding/odm-logo-full.svg` on the welcome screen.

Both ship as `.deb` packages and are tested against the same fixtures so they
produce identical resulting configuration.

## Joining

```
odm-client-install --domain corp.example.internal --admin-user Administrator
odm-client-install --domain corp.example.internal --otp <token>
```

Anything omitted is prompted for; `--unattended` fails instead. `--dry-run`
reports the steps without changing the machine, and `--root DIR` writes
beneath a directory instead of `/`, which is how the tests exercise the whole
sequence without a domain.

## What a join does

| Step | Result |
|---|---|
| Discovery | Locates controllers through `_ldap._tcp` service records |
| Kerberos | Writes `/etc/krb5.conf` for the realm |
| Join | `net ads join` with a credential, or token enrolment against the control plane |
| Keytab | Installs `/etc/krb5.keytab`, mode 0600 |
| Identity | Writes `/etc/sssd/sssd.conf`, mode 0600, and adds `sss` to nsswitch |
| Home directories | Enables `pam_mkhomedir` |
| Agent | Writes `/etc/odm/agent.json` and enables `odm-agent` |

A credential is fed to `net` on standard input, so it never appears in a
command line. Files the join replaces are backed up first.

## Building

```
go test ./...
go build -o odm-client-install ./cmd/odm-client-install
go build -tags gui -o odm-join-gui ./cmd/odm-join-gui
```

The desktop application is behind the `gui` build tag so the command and the
tests need no graphics toolchain. Building it needs `libgl1-mesa-dev`,
`xorg-dev`, `libwayland-dev` and `libxkbcommon-dev`.
