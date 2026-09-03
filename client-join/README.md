# Domain-join client

Command-line join for a Debian machine into an ODM domain, modelled on
`ipa-client-install`. Shipped in `odm-client.deb` alongside the agent and its
role installers.

- `join/` — the join sequence.
- `cmd/odm-client-install/` — the CLI.

## Joining

```
sudo apt install ./odm-client_<version>_amd64.deb
sudo odm-client-install --domain corp.example.internal --admin-user Administrator
sudo odm-client-install --domain corp.example.internal --otp <token>
```

Anything omitted is prompted for; `--unattended` fails instead of prompting.
`--dry-run` reports the steps without changing the machine, and `--root DIR`
writes beneath a directory instead of `/`, which is how the tests exercise
the whole sequence without a domain.

The credential is fed to `net` on standard input, so it never appears in a
command line, and files the join replaces are backed up first.

## What a join does

| Step | Result |
|---|---|
| Discovery | Locates controllers through `_ldap._tcp` service records |
| Kerberos | Writes `/etc/krb5.conf` for the realm |
| Join | `net ads join` with a credential, or token enrolment against the control plane |
| Keytab | Installs `/etc/krb5.keytab`, mode 0600 |
| Identity | Writes `/etc/sssd/sssd.conf`, mode 0600, and adds `sss` to nsswitch |
| Home directories | Enables `pam_mkhomedir` |
| Trust | Fetches the console's certificate from SYSVOL as this machine, over Kerberos |
| Agent | Writes `/etc/odm/agent.json` and enables `odm-agent` |

## Building

```
go test ./...
go build -o odm-client-install ./cmd/odm-client-install
```
