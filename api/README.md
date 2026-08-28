# ODM control-plane API

FastAPI service. Every LDAP, Kerberos and PostgreSQL interaction in ODM goes
through here — the web UI, the policy agent and the join client never talk to
the directory directly (CLAUDE.md §2).

## Layout

| File | Role |
|---|---|
| `odm/config.py` | Settings and the mode-checked secrets file |
| `odm/db.py` | asyncpg pool and the migration runner (`odm-db migrate`) |
| `odm/directory.py` | The only module that speaks LDAP: bind, group gate |
| `odm/sessions.py` | Server-side sessions, login throttling |
| `odm/security.py` | Security headers, origin checks, session/CSRF gates, authorization |
| `odm/authz.py` | Permissions, scopes and the delegation model |
| `odm/routes_rbac.py` | `/api/v1/rbac/*` — roles and assignments |
| `odm/ca.py` | Certificate authority: issuance, profiles, revocation lists |
| `odm/routes_ca.py` | `/api/v1/ca/*` |
| `odm/replication.py` | Multi-controller replication state and forced runs |
| `odm/backup.py` | Domain backup archives and retention |
| `odm/routes_operations.py` | `/api/v1/health`, `/replication/*`, `/backups` |
| `odm/enrolment.py` | Machine enrolment: tokens and keytab provisioning |
| `odm/routes_join.py` | `/api/v1/join/*` |
| `odm/objects.py` | Directory object CRUD, DN guard, protected-object guard |
| `odm/auth.py` | `/api/v1/auth/*` |
| `odm/routes_directory.py` | `/api/v1/directory/*` |
| `odm/routes_audit.py` | `/api/v1/audit/*` |
| `odm/policy.py` | Pure GPO precedence resolution and settings merge |
| `odm/policy_schema.py` | Typed, validated policy settings |
| `odm/admx.py` | ADMX/ADML parser and expansion into browser policy |
| `odm/routes_admx.py` | `/api/v1/admx/*` |
| `odm/dns.py` | Samba DNS via samba-tool, with per-type record validation |
| `odm/kea.py` | ISC Kea Control Agent client |
| `odm/routes_dns.py` | `/api/v1/dns/*` |
| `odm/routes_dhcp.py` | `/api/v1/dhcp/*` |
| `odm/roles.py` | Installable role registry and the privileged installer call |
| `odm/routes_roles.py` | `/api/v1/roles/*` |
| `odm/routes_recyclebin.py` | `/api/v1/recyclebin/*` and the retention sweep |
| `odm/rsop.py` | Effective-policy assembly from PostgreSQL plus LDAP facts |
| `odm/sysvol.py` | LDAP/SYSVOL mirror for GPMC interoperability |
| `odm/routes_policy.py` | `/api/v1/policy/*` |
| `odm/routes_agent.py` | `/api/v1/agent/*`, SPNEGO machine authentication |
| `odm/audit.py` | Append-only audit writes and the `audited` wrapper |
| `migrations/` | Numbered SQL, applied in order |

## Development

```
sudo apt-get install -y libkrb5-dev libsasl2-dev
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest
ruff check .
```

The tests stub the directory and the pool, so neither PostgreSQL nor a domain
controller is needed to run them.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/healthz` | Liveness plus a database round-trip |
| `POST` | `/api/v1/auth/login` | Username + password, LDAPS bind, group gate |
| `POST` | `/api/v1/auth/negotiate` | SPNEGO/Kerberos, same group gate |
| `GET` | `/api/v1/auth/session` | Current session |
| `POST` | `/api/v1/auth/logout` | Revokes the session; requires `X-ODM-CSRF` |
| `GET` | `/api/v1/directory/tree` | OUs and built-in containers |
| `GET` | `/api/v1/directory/objects` | List a container, or search the domain |
| `GET` | `/api/v1/directory/object` | One object by DN |
| `POST` | `/api/v1/directory/{users,groups,computers,ous}` | Create |
| `POST` | `/api/v1/directory/users/bulk` | Bulk create, per-row results |
| `PATCH` | `/api/v1/directory/object` | Update allow-listed attributes |
| `POST` | `/api/v1/directory/object/move` | Move or rename |
| `POST` | `/api/v1/directory/object/enabled` | Enable or disable an account |
| `POST` | `/api/v1/directory/user/password` | Reset a password |
| `POST` | `/api/v1/directory/group/members` | Bulk membership edit |
| `DELETE` | `/api/v1/directory/object` | Soft delete via the recycle bin |
| `GET` | `/api/v1/policy/gpos` | Group policy objects |
| `POST` | `/api/v1/policy/gpos` | Create a GPO |
| `PATCH` | `/api/v1/policy/gpo` | Name, state, settings, filtering, targeting |
| `DELETE` | `/api/v1/policy/gpo` | Delete a GPO and its links |
| `POST` | `/api/v1/policy/links` | Link a GPO to a container |
| `PATCH` | `/api/v1/policy/link` | Link order, enforced, enabled |
| `DELETE` | `/api/v1/policy/link` | Unlink |
| `POST` | `/api/v1/policy/inheritance` | Block inheritance on an OU |
| `GET` | `/api/v1/policy/effective` | RSoP preview for one object |
| `GET` | `/api/v1/policy/reports` | What agents last reported |
| `GET` | `/api/v1/agent/policy` | Machine's effective policy (SPNEGO) |
| `GET` | `/api/v1/agent/user-policy` | A user's policy on that machine (SPNEGO) |
| `POST` | `/api/v1/agent/report` | RSoP results from an agent (SPNEGO) |
| `POST` | `/api/v1/admx/templates` | Import an ADMX plus ADML pair |
| `GET` | `/api/v1/admx/templates` | Imported templates |
| `DELETE` | `/api/v1/admx/template` | Remove a template |
| `GET` | `/api/v1/admx/policies` | Search parsed settings |
| `GET` | `/api/v1/admx/categories` | Category tree for the picker |
| `GET` | `/api/v1/dns/zones` | Zones, with dynamic-update status |
| `GET` | `/api/v1/dns/zone` | One zone and its records |
| `POST` | `/api/v1/dns/zones` | Create a zone |
| `DELETE` | `/api/v1/dns/zone` | Delete a zone |
| `POST` | `/api/v1/dns/records` | Add a record |
| `PATCH` | `/api/v1/dns/record` | Change a record |
| `DELETE` | `/api/v1/dns/record` | Delete a record |
| `GET` | `/api/v1/dhcp/status` | Role state, failover state, pool utilisation |
| `GET` | `/api/v1/dhcp/scopes` | Scopes with pools, options and reservations |
| `POST` | `/api/v1/dhcp/scopes` | Create a scope |
| `PATCH` | `/api/v1/dhcp/scope` | Change a scope |
| `DELETE` | `/api/v1/dhcp/scope` | Delete a scope |
| `POST` | `/api/v1/dhcp/reservations` | Reserve an address |
| `DELETE` | `/api/v1/dhcp/reservation` | Release a reservation |
| `GET` | `/api/v1/dhcp/leases` | Current leases |
| `GET` | `/api/v1/recyclebin` | Deleted objects still inside the retention window |
| `GET` | `/api/v1/recyclebin/item` | One snapshot, with its attributes |
| `POST` | `/api/v1/recyclebin/restore` | Recreate an object and rejoin its groups |
| `DELETE` | `/api/v1/recyclebin/item` | Purge one snapshot now |
| `GET` | `/api/v1/roles` | Available roles and installed instances |
| `POST` | `/api/v1/roles/install` | Start an installation (202; poll the instance) |
| `GET` | `/api/v1/roles/instance` | Installation state and last error |
| `DELETE` | `/api/v1/roles/instance` | Deregister an instance |
| `GET` | `/api/v1/rbac/permissions` | Every permission a role can hold |
| `GET` | `/api/v1/rbac/roles` | Roles and their permissions |
| `POST` | `/api/v1/rbac/roles` | Define or redefine a custom role |
| `DELETE` | `/api/v1/rbac/role` | Delete a custom role |
| `GET` | `/api/v1/rbac/assignments` | Who holds what, where |
| `POST` | `/api/v1/rbac/assignments` | Grant a role at a scope |
| `DELETE` | `/api/v1/rbac/assignment` | Revoke an assignment |
| `GET` | `/api/v1/ca/status` | Authority state and inventory counts |
| `POST` | `/api/v1/ca/initialise` | Create the root authority |
| `GET` | `/api/v1/ca/root` | Root certificate, PEM |
| `GET` | `/api/v1/ca/crl` | Revocation list, PEM |
| `GET` | `/api/v1/ca/certificates` | Issued certificates |
| `POST` | `/api/v1/ca/issue` | Issue a server or client certificate |
| `POST` | `/api/v1/ca/revoke` | Revoke one |
| `POST` | `/api/v1/ca/publish` | Distribute the root through group policy |
| `POST` | `/api/v1/ca/console-certificate` | Re-issue and install the console's own |
| `POST` | `/api/v1/policy/bootstrap` | Create the two default policies |
| `GET` | `/api/v1/replication` | Controllers and inbound replication state |
| `POST` | `/api/v1/replication/replicate` | Force one replication run |
| `GET` | `/api/v1/backups` | Backup history and archives on disk |
| `POST` | `/api/v1/backups` | Take a backup now (202; poll the list) |
| `GET` | `/api/v1/health` | Directory, replication, DHCP, certificates, agents, backups |
| `GET` | `/api/v1/join/tokens` | Active enrolment tokens |
| `POST` | `/api/v1/join/tokens` | Create one; the value is returned once |
| `DELETE` | `/api/v1/join/token` | Revoke one |
| `POST` | `/api/v1/join/redeem` | Enrol a machine (token-authenticated, throttled) |
| `GET` | `/api/v1/audit` | Filterable audit log |

DNS and DHCP routers arrive in later phases.

DNs are passed in the query string or the body, never in the path — a DN
contains commas, equals signs and spaces, and path-escaping them is a bug
factory.

## Security notes

- LDAPS only, certificate validated against `ODM_LDAP_CA_CERT`.
- Empty passwords are rejected before any bind — an empty simple bind is an
  LDAP *unauthenticated* bind and succeeds.
- Usernames are validated against a strict charset and escaped before they
  reach a search filter.
- Session cookies are `HttpOnly`, `Secure`, `SameSite=Strict`; the database
  stores only their SHA-256.
- State-changing requests need a matching `X-ODM-CSRF` header and an allowed
  `Origin`.
- Repeated failures lock out by username and by source address.
- A session is issued to a member of the admin group, or to a principal
  holding a delegated assignment; anyone else is refused and the refusal is
  audited.
- The API surface is itself tested: exactly four endpoints answer without a
  session (login, negotiate, enrolment redemption, the liveness probe), every
  other endpoint carries an authorisation gate, agent endpoints use Kerberos
  rather than a session, and every permission a route names is one the model
  defines and at least one built-in role can hold.
- Every route declares the permission it needs. Scoped actions check it
  against the object's distinguished name, so an assignment at an OU reaches
  that OU and everything beneath it and nothing else. Moves are checked at
  both ends. Managing delegation is reserved for domain administrators.
- Admin-group membership is re-proven against the directory every
  `ODM_ADMIN_RECHECK_MINUTES`; a principal that lost it has its session
  revoked on its next privileged request.
- Every caller-supplied DN is parsed and proven to sit under the domain head.
- Attribute writes are restricted to per-type allow-lists; the domain head,
  built-in containers and built-in principals cannot be moved or deleted.
- Deletes snapshot the full object into the recycle bin before removal.
- `audit_log` is append-only, enforced by a trigger; refused writes are
  recorded too.
- Policy settings are validated against a typed schema before storage:
  absolute paths without traversal, octal modes, real systemd unit and cron
  shapes, sudo commands that cannot inject a second rule. The agent runs as
  root, so the document it receives is checked here, not there.
- Uploaded ADMX/ADML is parsed with defusedxml, so entity expansion,
  external entities and DTD retrieval are refused, and both files are size
  and element bounded.
- DNS arguments are validated per record type — addresses parsed, MX and SRV
  field shapes checked — and passed as argv elements; samba-tool is never
  invoked through a shell.
- Kea changes are config-tested before they are set, and only then written to
  disk. The Control Agent URL must be https unless it is on the loopback.
- CA private keys are written 0600 into the CA directory and never leave it;
  a leaf key is returned once in the issuing response and not stored.
- Replacing the console certificate stages the pair where the API can write
  and hands off to a privileged helper, which proves the key matches the
  certificate and that it is not already expired before installing it.
- Role installers need root and the API does not have it: it calls one fixed
  helper through a sudoers rule that names that single command, and only the
  arguments a role descriptor declares are passed, each pattern-checked.
- Restored objects come back disabled, and with a new SID — snapshot restore
  is not tombstone reanimation, which CLAUDE.md §5.3 deliberately does not
  rely on.
- Enrolment tokens are stored as their SHA-256 only. Redemption is
  unauthenticated by design, so it is throttled per source address and every
  attempt is audited; it returns that machine's own keytab and nothing else.
- Agents authenticate with SPNEGO only; there is no session cookie or CSRF
  token on `/api/v1/agent/*`, and the Kerberos principal names the computer
  object whose policy is served.
