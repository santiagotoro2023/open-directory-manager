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
| `GET` | `/api/v1/audit` | Filterable audit log |

Policy, DNS and DHCP routers arrive in later phases.

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
