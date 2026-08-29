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
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import audit, authz, directory, sessions, totp
from .config import Settings, get_settings
from .security import clear_session_cookie, current_session, get_pool, set_session_cookie
from .sessions import Session

log = logging.getLogger("odm.auth")

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=1, max_length=1024)
    # Sent on the second attempt, once the first has said one is needed.
    code: str | None = Field(default=None, max_length=32)


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
        # The client is told nothing useful on purpose, so the reason has to
        # be here or it exists nowhere: a directory ODM cannot reach is also a
        # directory it cannot write an audit record to.
        log.error("directory unavailable during sign-in: %s", exc)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "directory unavailable") from exc

    grants = await _admissible(pool, settings, user, source_ip, request)

    # The password was right. If this account has a second factor, that is not
    # yet enough — and the account is told so rather than being let in.
    async with pool.acquire() as conn:
        enrolment = await conn.fetchrow(
            "SELECT * FROM totp_enrolment WHERE principal_sid = $1 AND confirmed_at IS NOT NULL",
            user.sid,
        )
        if enrolment is not None:
            if not body.code:
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    "a code from your authenticator is required",
                    headers={"X-ODM-Second-Factor": "totp"},
                )
            if not await _accept_second_factor(conn, enrolment, body.code):
                await sessions.record_attempt(
                    conn,
                    username=body.username,
                    source_ip=source_ip,
                    succeeded=False,
                    reason="second factor rejected",
                )
                await audit.record(
                    conn,
                    actor=body.username,
                    actor_sid=user.sid,
                    source_ip=source_ip,
                    action="auth.login",
                    outcome="denied",
                    object_type="session",
                    detail="the second factor was rejected",
                )
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    "that code is not right",
                    headers={"X-ODM-Second-Factor": "totp"},
                )

        return await _issue(
            conn, settings, request, response, user, source_ip, "password", grants
        )


async def _accept_second_factor(
    conn: asyncpg.Connection, enrolment: asyncpg.Record, code: str
) -> bool:
    """A time-based code, or one of the recovery codes.

    A recovery code is consumed on use: it is a way back in for somebody who
    has lost their device, not a second password.
    """
    try:
        step = totp.verify(enrolment["secret"], code, last_step=enrolment["last_step"])
    except totp.TotpError:
        used = totp.matches_recovery(list(enrolment["recovery_codes"]), code)
        if used is None:
            return False
        await conn.execute(
            """
            UPDATE totp_enrolment
            SET recovery_codes = array_remove(recovery_codes, $2), updated_at = now()
            WHERE principal_sid = $1
            """,
            enrolment["principal_sid"],
            used,
        )
        return True

    # Remembering the step is what stops a code being replayed inside its
    # thirty-second window by anyone who saw it.
    await conn.execute(
        "UPDATE totp_enrolment SET last_step = $2, updated_at = now() WHERE principal_sid = $1",
        enrolment["principal_sid"],
        step,
    )
    return True


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
        # The client is told nothing useful on purpose, so the reason has to
        # be here or it exists nowhere: a directory ODM cannot reach is also a
        # directory it cannot write an audit record to.
        log.error("directory unavailable during sign-in: %s", exc)
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


# ------------------------------------------------------------ second factor --
# Enrolment is a two-step act on purpose: a secret is issued, and it only
# becomes required once a code from the device has been accepted. Nobody locks
# themselves out with a QR code they never scanned.


class EnrolRequest(BaseModel):
    code: str = Field(min_length=6, max_length=8)


@router.get("/second-factor")
async def second_factor_state(
    session: Session = Depends(current_session),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    row = await pool.fetchrow(
        "SELECT confirmed_at, recovery_codes FROM totp_enrolment WHERE principal_sid = $1",
        session.principal_sid,
    )
    return {
        "enrolled": bool(row and row["confirmed_at"]),
        "pending": bool(row and not row["confirmed_at"]),
        "recovery_codes_left": len(row["recovery_codes"]) if row else 0,
    }


@router.post("/second-factor", status_code=201)
async def begin_enrolment(
    request: Request,
    session: Session = Depends(current_session),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Issue a secret and the URI an authenticator scans.

    The secret is returned exactly once, here. A console that could read it
    back would hand it to anyone holding a stolen session.
    """
    if not session.principal_sid:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "this session has no account identifier"
        )
    secret = totp.generate_secret()
    async with pool.acquire() as conn:
        existing = await conn.fetchval(
            "SELECT confirmed_at FROM totp_enrolment WHERE principal_sid = $1",
            session.principal_sid,
        )
        if existing:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "this account already has a second factor; remove it before enrolling again",
            )
        await conn.execute(
            """
            INSERT INTO totp_enrolment (principal_sid, principal, secret, enrolled_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (principal_sid) DO UPDATE
                SET secret = excluded.secret, confirmed_at = NULL, last_step = NULL,
                    recovery_codes = '{}', updated_at = now()
            """,
            session.principal_sid,
            session.principal,
            secret,
            session.principal,
        )
    return {
        "secret": secret,
        "uri": totp.provisioning_uri(secret, session.principal, settings.domain),
        "digits": totp.DIGITS,
        "period": totp.PERIOD,
    }


@router.post("/second-factor/confirm")
async def confirm_enrolment(
    body: EnrolRequest,
    request: Request,
    session: Session = Depends(current_session),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Finish enrolling, by proving the device actually has the secret."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM totp_enrolment WHERE principal_sid = $1", session.principal_sid
        )
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nothing to confirm")
        try:
            step = totp.verify(row["secret"], body.code, last_step=row["last_step"])
        except totp.TotpError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

        codes = totp.generate_recovery_codes()
        await conn.execute(
            """
            UPDATE totp_enrolment
            SET confirmed_at = now(), last_step = $2, recovery_codes = $3, updated_at = now()
            WHERE principal_sid = $1
            """,
            session.principal_sid,
            step,
            codes,
        )
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=request.client.host if request.client else None,
            action="auth.second_factor.enrol",
            outcome="success",
            object_type="session",
            detail="a second factor was enrolled",
        )
    # Shown once, like the secret: a recovery code readable later is a password.
    return {"recovery_codes": codes}


@router.delete("/second-factor", status_code=204)
async def remove_enrolment(
    body: EnrolRequest,
    request: Request,
    session: Session = Depends(current_session),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Stop requiring a second factor for this account.

    A current code is required to remove it. Otherwise a stolen session could
    take the second factor off and keep the account.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM totp_enrolment WHERE principal_sid = $1", session.principal_sid
        )
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no second factor is enrolled")
        if not await _accept_second_factor(conn, row, body.code):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "that code is not right")
        await conn.execute(
            "DELETE FROM totp_enrolment WHERE principal_sid = $1", session.principal_sid
        )
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=request.client.host if request.client else None,
            action="auth.second_factor.remove",
            outcome="success",
            object_type="session",
            detail="the second factor was removed",
        )
