"""Request-level security: headers, origin checks, session and CSRF gates."""

from __future__ import annotations

import secrets
from dataclasses import replace

import asyncpg
from fastapi import Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from . import audit, authz, directory, sessions
from .config import Settings, get_settings
from .sessions import Session

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
CSRF_HEADER = "X-ODM-CSRF"

_RESPONSE_HEADERS = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cache-Control": "no-store",
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Adds hardening headers and rejects cross-origin state changes.

    Browsers always send Origin on cross-origin state-changing requests, so a
    mismatch is refused before any handler runs. Requests without Origin (the
    Go agent, curl) are left to the session/Kerberos gates.
    """

    async def dispatch(self, request: Request, call_next):
        if request.method not in SAFE_METHODS:
            origin = request.headers.get("origin")
            allowed = get_settings().allowed_origins
            if origin is not None and origin not in allowed:
                return JSONResponse(
                    {"detail": "origin not allowed"}, status_code=status.HTTP_403_FORBIDDEN
                )
        response: Response = await call_next(request)
        for key, value in _RESPONSE_HEADERS.items():
            response.headers.setdefault(key, value)
        return response


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def set_session_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=settings.session_ttl_minutes * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/",
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        settings.session_cookie_name,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/",
    )


def get_pool(request: Request) -> asyncpg.Pool:
    return request.app.state.pool


async def current_session(
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> Session:
    """Require a live session, and a matching CSRF token on state changes."""
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not authenticated")
    async with pool.acquire() as conn:
        session = await sessions.load(conn, settings, token)
    if session is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session expired")
    if request.method not in SAFE_METHODS:
        supplied = request.headers.get(CSRF_HEADER, "")
        if not secrets.compare_digest(supplied, session.csrf_token):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "csrf token mismatch")
    return session


async def require_admin(
    request: Request,
    session: Session = Depends(current_session),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> Session:
    """Gate for every route behind the console.

    A session proves who the caller was at sign-in, but group membership can
    change underneath it, so the directory is re-consulted every
    `admin_recheck_minutes`. A principal that has lost both its admin-group
    membership and any delegated assignment has its session revoked at once;
    a principal whose membership changed keeps the session with the new
    facts recorded on it.
    """
    async with pool.acquire() as conn:
        stale = await conn.fetchval(
            """
            SELECT admin_verified_at < now() - ($2 || ' minutes')::interval
            FROM admin_session WHERE id = $1::uuid
            """,
            session.id,
            str(settings.admin_recheck_minutes),
        )
    if not stale:
        return session

    try:
        current = await run_in_threadpool(
            directory.authorize_principal, settings, session.principal
        )
    except directory.NotAuthorized as exc:
        await _revoke(pool, request, session, settings, "account is no longer usable")
        raise HTTPException(status.HTTP_403_FORBIDDEN, "access revoked") from exc
    except directory.DirectoryError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "directory unavailable") from exc

    grants = await authz.grants_for(pool, current.sid, current.group_sids)
    if not current.is_domain_admin and not grants:
        await _revoke(pool, request, session, settings, "no remaining administrative assignment")
        raise HTTPException(status.HTTP_403_FORBIDDEN, "access revoked") from None

    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE admin_session
            SET admin_verified_at = now(), is_domain_admin = $2, group_sids = $3::text[]
            WHERE id = $1::uuid
            """,
            session.id,
            current.is_domain_admin,
            list(current.group_sids),
        )
    return replace(
        session, is_domain_admin=current.is_domain_admin, group_sids=current.group_sids
    )


async def _revoke(
    pool: asyncpg.Pool, request: Request, session: Session, settings: Settings, why: str
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE admin_session SET revoked_at = now() WHERE id = $1::uuid", session.id
        )
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="auth.revoke",
            outcome="denied",
            object_type="session",
            object_dn=session.principal_dn,
            detail=why,
        )


class Authz:
    """Per-request authorisation for the signed-in principal."""

    def __init__(self, session: Session, grants: list[authz.Grant], base_dn: str):
        self.session = session
        self.grants = grants
        self.base_dn = base_dn

    @property
    def domain_admin(self) -> bool:
        return self.session.is_domain_admin

    def allows(self, permission: str, dn: str | None = None) -> bool:
        return authz.permits(
            self.grants, permission, dn, self.base_dn, domain_admin=self.domain_admin
        )

    def require(self, permission: str, dn: str | None = None) -> None:
        """Raise 403 unless the caller holds `permission` over `dn`."""
        if self.allows(permission, dn):
            return
        where = f" on {dn}" if dn else ""
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"{permission} is not delegated{where}")

    def require_domain_admin(self) -> None:
        if not self.domain_admin:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "this action is reserved for domain administrators"
            )

    def describe(self) -> dict[str, object]:
        return authz.describe(self.grants, domain_admin=self.domain_admin)


async def authorization(
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> Authz:
    grants = (
        []
        if session.is_domain_admin
        else await authz.grants_for(pool, session.principal_sid, session.group_sids)
    )
    return Authz(session, grants, settings.base_dn)


def requires(permission: str):
    """Route dependency for a domain-wide permission.

    Scoped checks — anything that names an object — call authz.require()
    inside the handler, where the distinguished name is known.
    """

    async def dependency(authz: Authz = Depends(authorization)) -> None:
        authz.require(permission)

    return dependency


def requires_domain_admin():
    async def dependency(authz: Authz = Depends(authorization)) -> None:
        authz.require_domain_admin()

    return dependency
