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
| `odm/security.py` | Security headers, origin checks, session/CSRF gates |
| `odm/objects.py` | Directory object CRUD, DN guard, protected-object guard |
| `odm/auth.py` | `/api/v1/auth/*` |
| `odm/routes_directory.py` | `/api/v1/directory/*` |
| `odm/routes_audit.py` | `/api/v1/audit/*` |
| `odm/policy.py` | Pure GPO precedence resolution and settings merge |
| `odm/policy_schema.py` | Typed, validated policy settings |
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
- Agents authenticate with SPNEGO only; there is no session cookie or CSRF
  token on `/api/v1/agent/*`, and the Kerberos principal names the computer
  object whose policy is served.
