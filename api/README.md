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
| `odm/auth.py` | `/api/v1/auth/*` |
| `odm/audit.py` | Append-only audit writes |
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

## Endpoints (Phase 1)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/healthz` | Liveness plus a database round-trip |
| `POST` | `/api/v1/auth/login` | Username + password, LDAPS bind, group gate |
| `POST` | `/api/v1/auth/negotiate` | SPNEGO/Kerberos, same group gate |
| `GET` | `/api/v1/auth/session` | Current session |
| `POST` | `/api/v1/auth/logout` | Revokes the session; requires `X-ODM-CSRF` |

Directory, policy, DNS and DHCP routers arrive in later phases.

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
- `audit_log` is append-only, enforced by a trigger.
