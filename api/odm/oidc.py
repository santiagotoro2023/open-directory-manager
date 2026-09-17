"""The console as the domain's OpenID Connect provider.

Anything that can sign people in with OpenID Connect — the password manager
first — can send them here, and here they sign in with their domain
account: without typing, when the browser hands over the Kerberos ticket the
desktop session already holds (the password-manager setting tells Firefox
and Chromium to trust the console with it), or with their domain name and
password otherwise. Either way the application gets a signed statement of
who they are, with the address the directory knows them by, and never sees
a password.

It is the smallest provider that does the job, and only the job: the
authorization-code flow with PKCE, RS256-signed id tokens, a userinfo
endpoint, and clients registered by the console itself — the password
manager's is made when its sign-in is switched on. There is no consent
screen, because every client here is the domain's own.
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import logging
import secrets
import time
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import asyncpg
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from . import audit, directory, sessions
from .auth import _accept_spnego
from .config import Settings, get_settings
from .security import client_ip, get_pool

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/oidc", tags=["oidc"])

CODE_LIFETIME = 120
TOKEN_LIFETIME = 3600
REFRESH_LIFETIME = 30 * 24 * 3600
KEY_BITS = 3072


def issuer(settings: Settings) -> str:
    return settings.console_url.rstrip("/") + "/api/v1/oidc"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _int_b64(value: int) -> str:
    return _b64(value.to_bytes((value.bit_length() + 7) // 8, "big"))


def _form(raw: bytes) -> dict[str, str]:
    parsed = parse_qs(raw.decode(errors="replace"), keep_blank_values=True)
    return {key: values[0] for key, values in parsed.items()}


# --- The signing key --------------------------------------------------------


async def signing_key(pool: asyncpg.Pool) -> tuple[str, rsa.RSAPrivateKey]:
    """The provider's one key, made the first time it is needed and kept in
    the database: every controller signs with the same key, so a token from
    one is verified by a client that fetched the keys from another."""
    row = await pool.fetchrow("SELECT kid, private_pem FROM oidc_key WHERE id = 1")
    if row is None:
        key = rsa.generate_private_key(public_exponent=65537, key_size=KEY_BITS)
        pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode()
        kid = secrets.token_hex(8)
        await pool.execute(
            "INSERT INTO oidc_key (id, kid, private_pem) VALUES (1, $1, $2) ON CONFLICT DO NOTHING",
            kid, pem,
        )
        row = await pool.fetchrow("SELECT kid, private_pem FROM oidc_key WHERE id = 1")
    loaded = serialization.load_pem_private_key(row["private_pem"].encode(), password=None)
    assert isinstance(loaded, rsa.RSAPrivateKey)
    return row["kid"], loaded


def jwk(kid: str, key: rsa.RSAPrivateKey) -> dict[str, Any]:
    numbers = key.public_key().public_numbers()
    return {
        "kty": "RSA", "use": "sig", "alg": "RS256", "kid": kid,
        "n": _int_b64(numbers.n), "e": _int_b64(numbers.e),
    }


def sign_jwt(kid: str, key: rsa.RSAPrivateKey, claims: dict[str, Any]) -> str:
    header = _b64(json.dumps({"alg": "RS256", "typ": "JWT", "kid": kid}).encode())
    payload = _b64(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{header}.{payload}".encode()
    signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{payload}.{_b64(signature)}"


# --- Clients ----------------------------------------------------------------


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


async def register_client(
    conn: asyncpg.Connection, client_id: str, name: str, redirect_uris: list[str]
) -> str:
    """Make or refresh a client: a new secret each time, returned once.

    The console keeps the secret where the client's configuration lives
    (the password manager's row), never here — here it is a hash."""
    secret = secrets.token_urlsafe(32)
    await conn.execute(
        """
        INSERT INTO oidc_client (client_id, name, secret_hash, redirect_uris)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (client_id) DO UPDATE
            SET name = EXCLUDED.name, secret_hash = EXCLUDED.secret_hash,
                redirect_uris = EXCLUDED.redirect_uris
        """,
        client_id, name, _hash_secret(secret), json.dumps(redirect_uris),
    )
    return secret


async def update_redirects(
    conn: asyncpg.Connection, client_id: str, redirect_uris: list[str]
) -> None:
    await conn.execute(
        "UPDATE oidc_client SET redirect_uris = $2::jsonb WHERE client_id = $1",
        client_id, json.dumps(redirect_uris),
    )


async def _client(conn: asyncpg.Connection | asyncpg.Pool, client_id: str) -> asyncpg.Record | None:
    if not client_id or len(client_id) > 128:
        return None
    return await conn.fetchrow("SELECT * FROM oidc_client WHERE client_id = $1", client_id)


def _redirects(row: asyncpg.Record) -> list[str]:
    raw = row["redirect_uris"]
    return list(raw) if isinstance(raw, list) else json.loads(raw or "[]")


# --- Who somebody is --------------------------------------------------------


def claims_for(settings: Settings, user: directory.DirectoryUser) -> dict[str, Any]:
    """What a client is told. The subject is the account's SID: stable
    across renames, unlike any name. The address is the directory's, or the
    account name at the domain where none is set — the same rule the
    password manager's directory sync applies, so the two agree on who a
    person is."""
    sam = user.sam_account_name
    mail = user.mail or f"{sam}@{settings.domain}"
    return {
        "sub": user.sid or user.user_principal_name,
        "email": mail.lower(),
        "email_verified": True,
        "preferred_username": sam,
        "name": user.display_name,
    }


# --- Discovery --------------------------------------------------------------


@router.get("/.well-known/openid-configuration")
async def configuration(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    base = issuer(settings)
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/authorize",
        "token_endpoint": f"{base}/token",
        "userinfo_endpoint": f"{base}/userinfo",
        "jwks_uri": f"{base}/jwks",
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "scopes_supported": ["openid", "profile", "email", "offline_access"],
        "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
        "claims_supported": ["sub", "email", "email_verified", "preferred_username", "name"],
        "code_challenge_methods_supported": ["S256"],
    }


@router.get("/jwks")
async def jwks(pool: asyncpg.Pool = Depends(get_pool)) -> dict[str, Any]:
    kid, key = await signing_key(pool)
    return {"keys": [jwk(kid, key)]}


# --- Authorization ----------------------------------------------------------


class AuthRequest:
    """The parameters of one authorization request, checked once."""

    def __init__(self, params: dict[str, str], client: asyncpg.Record) -> None:
        self.client_id = params.get("client_id", "")
        self.redirect_uri = params.get("redirect_uri", "")
        self.state = params.get("state", "")
        self.nonce = params.get("nonce", "")
        self.scope = params.get("scope", "openid")
        self.code_challenge = params.get("code_challenge", "")
        self.method = params.get("code_challenge_method", "")
        if params.get("response_type") != "code":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "only the code flow is supported")
        if self.redirect_uri not in _redirects(client):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "that redirect address is not registered"
            )
        if "openid" not in self.scope.split():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "the openid scope is required")
        if self.code_challenge and self.method != "S256":
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "only S256 code challenges are supported"
            )
        for value in (self.state, self.nonce, self.code_challenge, self.scope):
            if len(value) > 512:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "a parameter is too long")

    def fields(self) -> dict[str, str]:
        return {
            "client_id": self.client_id, "redirect_uri": self.redirect_uri,
            "response_type": "code", "state": self.state, "nonce": self.nonce,
            "scope": self.scope, "code_challenge": self.code_challenge,
            "code_challenge_method": self.method,
        }


async def _issue_code(
    conn: asyncpg.Connection, settings: Settings, req: AuthRequest, user: directory.DirectoryUser
) -> str:
    code = secrets.token_urlsafe(32)
    await conn.execute(
        """
        INSERT INTO oidc_code
            (code, client_id, redirect_uri, nonce, code_challenge, claims, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, now() + ($7 || ' seconds')::interval)
        """,
        code, req.client_id, req.redirect_uri, req.nonce, req.code_challenge,
        json.dumps(claims_for(settings, user)), str(CODE_LIFETIME),
    )
    await conn.execute("DELETE FROM oidc_code WHERE expires_at < now()")
    return code


def _redirect_with_code(req: AuthRequest, code: str) -> Response:
    query = {"code": code}
    if req.state:
        query["state"] = req.state
    separator = "&" if "?" in req.redirect_uri else "?"
    return RedirectResponse(req.redirect_uri + separator + urlencode(query), status_code=303)


def _page(
    req: AuthRequest, client_name: str, *, error: str = "", username: str = "", negotiate: bool
) -> Response:
    """The sign-in page. Served with a 401 that asks for a ticket when there
    is a chance of one: a browser that trusts the console with the desktop
    session's ticket answers it without showing the page; every other
    browser shows the page."""
    nonce = secrets.token_urlsafe(16)
    hidden = "".join(
        f'<input type="hidden" name="{html.escape(k)}" value="{html.escape(v)}">'
        for k, v in req.fields().items() if v
    )
    body = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Open Directory Manager</title>
<style nonce="{nonce}">
  :root {{ color-scheme: light; }}
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #F8FAFC;
         font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #0F172A; }}
  main {{ width: min(380px, calc(100vw - 32px)); background: #fff; border: 1px solid #E2E8F0;
          border-radius: 16px; padding: 32px; box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }}
  img {{ height: 36px; display: block; margin-bottom: 24px; }}
  h1 {{ font-size: 18px; margin: 0 0 4px; }}
  p {{ margin: 0 0 20px; color: #475569; }}
  label {{ display: block; font-weight: 500; margin-bottom: 14px; }}
  input:not([type=hidden]) {{ display: block; width: 100%; box-sizing: border-box;
           margin-top: 4px; padding: 9px 11px; border: 1px solid #CBD5E1;
           border-radius: 8px; font: inherit; }}
  input:focus {{ outline: 2px solid #4F46E5; outline-offset: 1px; border-color: #4F46E5; }}
  button {{ width: 100%; padding: 10px; border: 0; border-radius: 8px; background: #4F46E5;
            color: #fff; font: inherit; font-weight: 600; cursor: pointer; }}
  .error {{ background: #FEF2F2; color: #991B1B; border: 1px solid #FECACA; border-radius: 8px;
            padding: 8px 12px; margin-bottom: 16px; }}
</style>
</head>
<body>
<main>
  <img src="/odm-logo-full.svg" alt="Open Directory Manager">
  <h1>Sign in to {html.escape(client_name)}</h1>
  <p>With your domain account.</p>
  {f'<div class="error" role="alert">{html.escape(error)}</div>' if error else ""}
  <form method="post" action="authorize">
    {hidden}
    <label>User name
      <input name="username" value="{html.escape(username)}" autocomplete="username"
             autofocus required>
    </label>
    <label>Password
      <input name="password" type="password" autocomplete="current-password" required>
    </label>
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>
"""
    target = urlsplit(req.redirect_uri)
    headers = {
        # Its own policy: the stylesheet above, the brand mark, a form that
        # posts back here, and the redirect onwards to the client (which a
        # browser holds a submitted form to as well). Framable by the
        # console itself: the vault is shown inside the Passwords page, and
        # its sign-in comes here inside that same frame.
        "Content-Security-Policy": (
            f"default-src 'none'; img-src 'self'; style-src 'nonce-{nonce}'; "
            f"form-action 'self' {target.scheme}://{target.netloc}; "
            "base-uri 'none'; frame-ancestors 'self'"
        ),
        "X-Frame-Options": "SAMEORIGIN",
    }
    if negotiate:
        headers["WWW-Authenticate"] = "Negotiate"
        return HTMLResponse(body, status_code=status.HTTP_401_UNAUTHORIZED, headers=headers)
    return HTMLResponse(body, headers=headers)


async def _request(
    pool: asyncpg.Pool, params: dict[str, str]
) -> tuple[AuthRequest, asyncpg.Record]:
    client = await _client(pool, params.get("client_id", ""))
    if client is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unknown client")
    return AuthRequest(params, client), client


@router.get("/authorize")
async def authorize(
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> Response:
    req, client = await _request(pool, dict(request.query_params))
    header = request.headers.get("authorization", "")
    scheme, _, payload = header.partition(" ")
    if scheme.lower() == "negotiate" and payload and settings.keytab is not None:
        # A ticket: the browser trusts the console with the desktop's own.
        try:
            token = base64.b64decode(payload, validate=True)
            principal, _out = await run_in_threadpool(_accept_spnego, settings, token)
            user = await run_in_threadpool(directory.authorize_principal, settings, principal)
        except HTTPException:
            return _page(req, client["name"], negotiate=False)
        except (directory.NotAuthorized, directory.DirectoryError) as exc:
            log.warning("openid sign-in with a ticket refused: %s", exc)
            return _page(req, client["name"], negotiate=False,
                         error="This account cannot sign in.")
        except ValueError:
            return _page(req, client["name"], negotiate=False)
        async with pool.acquire() as conn:
            code = await _issue_code(conn, settings, req, user)
            await audit.record(
                conn, actor=user.user_principal_name, actor_sid=user.sid,
                source_ip=client_ip(request), action="oidc.sign-in", outcome="success",
                object_type="client", object_dn=req.client_id, detail="kerberos",
            )
        return _redirect_with_code(req, code)
    return _page(req, client["name"], negotiate=settings.keytab is not None)


@router.post("/authorize")
async def authorize_with_password(
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> Response:
    raw = await request.body()
    if len(raw) > 8192:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "form too large")
    form = _form(raw)
    req, client = await _request(pool, form)
    username = form.get("username", "").strip()
    password = form.get("password", "")
    source_ip = client_ip(request)

    def again(error: str) -> Response:
        return _page(req, client["name"], negotiate=False, error=error, username=username)

    if not username or not password:
        return again("Both a user name and a password are needed.")
    async with pool.acquire() as conn:
        failures = await sessions.recent_failures(
            conn, username, source_ip, settings.login_lockout_minutes
        )
        if sessions.should_lock(failures, settings.login_max_failures):
            await audit.record(
                conn, actor=username, source_ip=source_ip, action="oidc.sign-in",
                outcome="denied", object_type="client", object_dn=req.client_id,
                detail="locked out after repeated failures",
            )
            return again("Too many failed attempts. Try again later.")
    try:
        user = await run_in_threadpool(directory.authenticate, settings, username, password)
    except (directory.InvalidCredentials, directory.NotAuthorized) as exc:
        log.warning("openid sign-in refused for %r: %s", username, exc)
        async with pool.acquire() as conn:
            await sessions.record_attempt(
                conn, username=username, source_ip=source_ip, succeeded=False, reason=str(exc)
            )
            await audit.record(
                conn, actor=username, source_ip=source_ip, action="oidc.sign-in",
                outcome="denied" if isinstance(exc, directory.NotAuthorized) else "failure",
                object_type="client", object_dn=req.client_id, detail=str(exc),
            )
        return again("The user name or password is wrong.")
    except directory.DirectoryError as exc:
        log.error("directory unavailable during openid sign-in: %s", exc)
        return again("The directory cannot be reached right now.")
    async with pool.acquire() as conn:
        await sessions.record_attempt(
            conn, username=username, source_ip=source_ip, succeeded=True
        )
        code = await _issue_code(conn, settings, req, user)
        await audit.record(
            conn, actor=user.user_principal_name, actor_sid=user.sid, source_ip=source_ip,
            action="oidc.sign-in", outcome="success", object_type="client",
            object_dn=req.client_id, detail="password",
        )
    return _redirect_with_code(req, code)


# --- Tokens -----------------------------------------------------------------


def _error(code: str, description: str, status_code: int = 400) -> JSONResponse:
    return JSONResponse({"error": code, "error_description": description}, status_code=status_code)


async def _authenticate_client(
    request: Request, form: dict[str, str], pool: asyncpg.Pool
) -> asyncpg.Record | None:
    client_id, secret = form.get("client_id", ""), form.get("client_secret", "")
    header = request.headers.get("authorization", "")
    scheme, _, payload = header.partition(" ")
    if scheme.lower() == "basic" and payload:
        try:
            decoded = base64.b64decode(payload, validate=True).decode()
        except (ValueError, UnicodeDecodeError):
            return None
        client_id, _, secret = decoded.partition(":")
    client = await _client(pool, client_id)
    if client is None or not secrets.compare_digest(client["secret_hash"], _hash_secret(secret)):
        return None
    return client


async def _tokens(
    pool: asyncpg.Pool, settings: Settings, client_id: str, claims: dict[str, Any],
    nonce: str, scope: str,
) -> dict[str, Any]:
    kid, key = await signing_key(pool)
    now = int(time.time())
    id_claims = {
        "iss": issuer(settings), "aud": client_id, "iat": now, "exp": now + TOKEN_LIFETIME,
        "auth_time": now, **claims,
    }
    if nonce:
        id_claims["nonce"] = nonce
    access = secrets.token_urlsafe(32)
    refresh = secrets.token_urlsafe(32)
    await pool.execute(
        """
        INSERT INTO oidc_token (token, kind, client_id, claims, nonce, scope, expires_at)
        VALUES ($1, 'access', $2, $3::jsonb, $4, $5, now() + ($6 || ' seconds')::interval),
               ($7, 'refresh', $2, $3::jsonb, $4, $5, now() + ($8 || ' seconds')::interval)
        """,
        access, client_id, json.dumps(claims), nonce, scope, str(TOKEN_LIFETIME),
        refresh, str(REFRESH_LIFETIME),
    )
    await pool.execute("DELETE FROM oidc_token WHERE expires_at < now()")
    return {
        "access_token": access, "token_type": "Bearer", "expires_in": TOKEN_LIFETIME,
        "refresh_token": refresh, "scope": scope,
        "id_token": sign_jwt(kid, key, id_claims),
    }


@router.post("/token")
async def token(
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> Response:
    raw = await request.body()
    if len(raw) > 8192:
        return _error("invalid_request", "too large")
    form = _form(raw)
    client = await _authenticate_client(request, form, pool)
    if client is None:
        return _error("invalid_client", "client authentication failed", 401)
    grant = form.get("grant_type", "")
    if grant == "authorization_code":
        code = form.get("code", "")
        if not code or len(code) > 128:
            return _error("invalid_grant", "no code")
        # Used once: taken out as it is read, so a second exchange fails.
        row = await pool.fetchrow(
            "DELETE FROM oidc_code WHERE code = $1 AND client_id = $2 RETURNING *",
            code, client["client_id"],
        )
        if row is None or row["expires_at"].timestamp() < time.time():
            return _error("invalid_grant", "the code is unknown or expired")
        if form.get("redirect_uri", "") != row["redirect_uri"]:
            return _error("invalid_grant", "redirect_uri does not match")
        if row["code_challenge"]:
            verifier = form.get("code_verifier", "")
            digest = _b64(hashlib.sha256(verifier.encode()).digest())
            if not verifier or not secrets.compare_digest(digest, row["code_challenge"]):
                return _error("invalid_grant", "the code verifier does not match")
        claims = row["claims"] if isinstance(row["claims"], dict) else json.loads(row["claims"])
        return JSONResponse(
            await _tokens(
                pool, settings, client["client_id"], claims, row["nonce"], "openid profile email"
            )
        )
    if grant == "refresh_token":
        refresh = form.get("refresh_token", "")
        if not refresh or len(refresh) > 128:
            return _error("invalid_grant", "no refresh token")
        row = await pool.fetchrow(
            "DELETE FROM oidc_token WHERE token = $1 AND kind = 'refresh' AND client_id = $2"
            " AND expires_at > now() RETURNING *",
            refresh, client["client_id"],
        )
        if row is None:
            return _error("invalid_grant", "the refresh token is unknown or expired")
        claims = row["claims"] if isinstance(row["claims"], dict) else json.loads(row["claims"])
        return JSONResponse(
            await _tokens(pool, settings, client["client_id"], claims, row["nonce"], row["scope"])
        )
    return _error("unsupported_grant_type", "only authorization_code and refresh_token")


@router.get("/userinfo")
@router.post("/userinfo")
async def userinfo(request: Request, pool: asyncpg.Pool = Depends(get_pool)) -> Response:
    header = request.headers.get("authorization", "")
    scheme, _, access = header.partition(" ")
    if scheme.lower() != "bearer" or not access or len(access) > 128:
        return JSONResponse(
            {"error": "invalid_token"}, status_code=401, headers={"WWW-Authenticate": "Bearer"}
        )
    row = await pool.fetchrow(
        "SELECT claims FROM oidc_token WHERE token = $1 AND kind = 'access' AND expires_at > now()",
        access,
    )
    if row is None:
        return JSONResponse(
            {"error": "invalid_token"}, status_code=401, headers={"WWW-Authenticate": "Bearer"}
        )
    claims = row["claims"] if isinstance(row["claims"], dict) else json.loads(row["claims"])
    return JSONResponse(claims)
