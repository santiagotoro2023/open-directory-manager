"""Authentication endpoints.

Two ways in, one gate: a session is issued only to a member of the
configured Domain-Admins-equivalent group, or to a principal holding a
delegated assignment. ODM stores no passwords and has no user table of its
own (CLAUDE.md §3.1, §4).

  POST /api/v1/auth/login      username + password, LDAPS bind against Samba
  POST /api/v1/auth/negotiate  SPNEGO/Kerberos, for SSO and domain-joined callers
  GET  /api/v1/auth/session    current session
  POST /api/v1/auth/logout     revoke it
"""

from __future__ import annotations

import base64
import binascii
import logging
from datetime import datetime

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import audit, authz, directory, sessions
from .config import Settings, get_settings
from .security import clear_session_cookie, current_session, get_pool, set_session_cookie
from .sessions import Session

log = logging.getLogger("odm.auth")

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=1, max_length=1024)


class SessionResponse(BaseModel):
    principal: str
    display_name: str
    distinguished_name: str
    csrf_token: str
    expires_at: datetime
    domain_admin: bool = True
    # What this operator may do, so the console can hide what they cannot.
    permissions: list[str] = []
    scopes: list[dict[str, str]] = []


def _response(session: Session, grants: list[authz.Grant] | None = None) -> SessionResponse:
    reach = authz.describe(grants or [], domain_admin=session.is_domain_admin)
    return SessionResponse(
        principal=session.principal,
        display_name=session.display_name,
        distinguished_name=session.principal_dn,
        csrf_token=session.csrf_token,
        expires_at=session.expires_at,
        domain_admin=session.is_domain_admin,
        permissions=list(reach["permissions"]),  # type: ignore[arg-type]
        scopes=list(reach["scopes"]),  # type: ignore[arg-type]
    )


async def _issue(
    conn: asyncpg.Connection,
    settings: Settings,
    request: Request,
    response: Response,
    user: directory.DirectoryUser,
    source_ip: str | None,
    method: str,
    grants: list[authz.Grant] | None = None,
) -> SessionResponse:
    token, session = await sessions.create(
        conn,
        settings,
        user,
        source_ip=source_ip,
        user_agent=request.headers.get("user-agent"),
    )
    await sessions.record_attempt(
        conn, username=user.user_principal_name, source_ip=source_ip, succeeded=True
    )
    await audit.record(
        conn,
        actor=user.user_principal_name,
        actor_sid=user.sid,
        source_ip=source_ip,
        action="auth.login",
        outcome="success",
        object_type="session",
        object_dn=user.dn,
        detail=f"{method}; domain admin" if user.is_domain_admin else f"{method}; delegated",
    )
    set_session_cookie(response, settings, token)
    return _response(session, grants)


@router.post("/login", response_model=SessionResponse)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> SessionResponse:
    source_ip = request.client.host if request.client else None

    async with pool.acquire() as conn:
        failures = await sessions.recent_failures(
            conn, body.username, source_ip, settings.login_lockout_minutes
        )
        if sessions.should_lock(failures, settings.login_max_failures):
            await audit.record(
                conn,
                actor=body.username,
                source_ip=source_ip,
                action="auth.login",
                outcome="denied",
                object_type="session",
                detail="locked out after repeated failures",
            )
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "too many failed attempts, try again later",
                headers={"Retry-After": str(settings.login_lockout_minutes * 60)},
            )

    try:
        user = await run_in_threadpool(
            directory.authenticate, settings, body.username, body.password
        )
    except (directory.InvalidCredentials, directory.NotAuthorized) as exc:
        denied = isinstance(exc, directory.NotAuthorized)
        # The browser is told only that the credentials were rejected. The
        # reason the directory gave belongs in the journal: until someone can
        # sign in, the audit log the same reason is written to cannot be read.
        log.warning("sign-in refused for %r: %s", body.username, exc)
        async with pool.acquire() as conn:
            await sessions.record_attempt(
                conn,
                username=body.username,
                source_ip=source_ip,
                succeeded=False,
                reason=str(exc),
            )
            await audit.record(
                conn,
                actor=body.username,
                source_ip=source_ip,
                action="auth.login",
                outcome="denied" if denied else "failure",
                object_type="session",
                detail=str(exc),
            )
        if denied:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, f"not a member of {settings.admin_group}"
            ) from exc
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials") from exc
    except directory.DirectoryError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "directory unavailable") from exc

    grants = await _admissible(pool, settings, user, source_ip, request)
    async with pool.acquire() as conn:
        return await _issue(
            conn, settings, request, response, user, source_ip, "password", grants
        )


async def _admissible(
    pool: asyncpg.Pool,
    settings: Settings,
    user: directory.DirectoryUser,
    source_ip: str | None,
    request: Request,
) -> list[authz.Grant]:
    """Decide whether this principal may open a console session.

    Membership of the admin group admits unconditionally. Everyone else needs
    at least one delegated assignment (CLAUDE.md §4).
    """
    grants = [] if user.is_domain_admin else await authz.grants_for(
        pool, user.sid, user.group_sids
    )
    if user.is_domain_admin or grants:
        return grants

    async with pool.acquire() as conn:
        await sessions.record_attempt(
            conn,
            username=user.user_principal_name,
            source_ip=source_ip,
            succeeded=False,
            reason="no administrative rights",
        )
        await audit.record(
            conn,
            actor=user.user_principal_name,
            actor_sid=user.sid,
            source_ip=source_ip,
            action="auth.login",
            outcome="denied",
            object_type="session",
            object_dn=user.dn,
            detail=f"not in {settings.admin_group} and holds no delegated assignment",
        )
    raise HTTPException(
        status.HTTP_403_FORBIDDEN,
        f"not a member of {settings.admin_group}, and nothing is delegated to this account",
    )


@router.post("/negotiate", response_model=SessionResponse)
async def negotiate(
    request: Request,
    response: Response,
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> SessionResponse:
    """SPNEGO: accept a Kerberos ticket, then apply the same group gate."""
    if settings.keytab is None:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "no service keytab configured")

    header = request.headers.get("authorization", "")
    scheme, _, payload = header.partition(" ")
    if scheme.lower() != "negotiate" or not payload:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "kerberos ticket required",
            headers={"WWW-Authenticate": "Negotiate"},
        )
    try:
        token = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "malformed negotiate token") from exc

    principal, out_token = await run_in_threadpool(_accept_spnego, settings, token)
    if out_token:
        response.headers["WWW-Authenticate"] = f"Negotiate {base64.b64encode(out_token).decode()}"

    source_ip = request.client.host if request.client else None
    try:
        user = await run_in_threadpool(directory.authorize_principal, settings, principal)
    except directory.NotAuthorized as exc:
        async with pool.acquire() as conn:
            await audit.record(
                conn,
                actor=principal,
                source_ip=source_ip,
                action="auth.login",
                outcome="denied",
                object_type="session",
                detail=str(exc),
            )
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, f"not a member of {settings.admin_group}"
        ) from exc
    except directory.DirectoryError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "directory unavailable") from exc

    grants = await _admissible(pool, settings, user, source_ip, request)
    async with pool.acquire() as conn:
        return await _issue(
            conn, settings, request, response, user, source_ip, "kerberos", grants
        )


def _accept_spnego(settings: Settings, token: bytes) -> tuple[str, bytes | None]:
    """Complete one GSSAPI acceptor step. Blocking.

    Imported lazily so the rest of the API (and its unit tests) do not need
    the Kerberos runtime present just to be imported.
    """
    import gssapi  # noqa: PLC0415

    try:
        context = gssapi.SecurityContext(creds=None, usage="accept")
        out_token = context.step(token)
    except gssapi.exceptions.GSSError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "kerberos authentication failed") from exc
    if not context.complete:
        # Multi-leg SPNEGO (NTLM fallback, mutual auth loops) is out of scope:
        # domain-joined callers complete in one leg.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "incomplete kerberos exchange")
    return str(context.initiator_name), out_token


@router.get("/session", response_model=SessionResponse)
async def read_session(
    session: Session = Depends(current_session),
    pool: asyncpg.Pool = Depends(get_pool),
) -> SessionResponse:
    grants = (
        []
        if session.is_domain_admin
        else await authz.grants_for(pool, session.principal_sid, session.group_sids)
    )
    return _response(session, grants)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    session: Session = Depends(current_session),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
):
    token = request.cookies.get(settings.session_cookie_name, "")
    async with pool.acquire() as conn:
        await sessions.revoke(conn, token)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=request.client.host if request.client else None,
            action="auth.logout",
            outcome="success",
            object_type="session",
            object_dn=session.principal_dn,
        )
    clear_session_cookie(response, settings)
