"""Machine enrolment endpoints (CLAUDE.md §5.6).

Creating a token needs a domain administrator. Redeeming one does not — that
is the point: a machine enrols without a domain administrator credential ever
reaching it. Redemption is therefore throttled by source address and every
attempt is audited.
"""

from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timedelta
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import audit, enrolment, objects, sessions
from .config import Settings, get_settings
from .routes_directory import _audit_context, _bound
from .security import client_ip, get_pool, require_admin, requires_domain_admin
from .sessions import Session

router = APIRouter(prefix="/api/v1/join", tags=["join"])

REDEEM_THROTTLE_KEY = "join-redeem"
MAX_REDEEM_FAILURES = 10
THROTTLE_WINDOW_MINUTES = 15


class CreateToken(BaseModel):
    label: Annotated[str, Field(default="", max_length=128)] = ""
    container_dn: Annotated[str, Field(min_length=3, max_length=1024)]
    hostname: Annotated[str | None, Field(default=None, max_length=253)] = None
    uses_allowed: Annotated[int, Field(ge=1, le=1000)] = 1
    ttl_minutes: Annotated[int, Field(ge=5, le=43_200)] = 1440


class RedeemRequest(BaseModel):
    token: Annotated[str, Field(min_length=16, max_length=128)]
    hostname: Annotated[str, Field(min_length=1, max_length=253)]
    operating_system: Annotated[str, Field(default="", max_length=64)] = ""


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@router.get("/tokens", dependencies=[Depends(requires_domain_admin())])
async def list_tokens(pool: asyncpg.Pool = Depends(get_pool)) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT id, label, container_dn, hostname, uses_allowed, uses_spent, expires_at,
               created_by, created_at, revoked_at, last_used_at, last_used_by
        FROM join_token
        WHERE revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC
        """
    )
    return {"tokens": [{**dict(row), "id": str(row["id"])} for row in rows]}


@router.post("/tokens", status_code=201, dependencies=[Depends(requires_domain_admin())])
async def create_token(
    body: CreateToken,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Create an enrolment token. The value is returned once."""
    async with _audit_context(
        request, session, pool, "join.token.create", object_type="join_token",
        object_dn=body.container_dn,
    ) as entry:
        async with _bound(settings, write=False) as conn:
            await run_in_threadpool(objects.get, conn, settings, body.container_dn)

        hostname = enrolment.validate_hostname(body.hostname) if body.hostname else None
        token = enrolment.new_token()
        expires_at = datetime.now().astimezone() + timedelta(minutes=body.ttl_minutes)
        row = await pool.fetchrow(
            """
            INSERT INTO join_token (token_sha256, label, container_dn, hostname, uses_allowed,
                                    expires_at, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
            """,
            _hash(token),
            body.label,
            body.container_dn,
            hostname,
            body.uses_allowed,
            expires_at,
            session.principal,
        )
        entry.after = {
            "container": body.container_dn,
            "uses_allowed": body.uses_allowed,
            "expires_at": str(expires_at),
        }
        return {
            "id": str(row["id"]),
            "token": token,
            "expires_at": expires_at,
            "uses_allowed": body.uses_allowed,
            "command": (
                f"odm-client-install --domain {settings.domain} --otp {token}"
            ),
        }


@router.delete("/token", status_code=204, dependencies=[Depends(requires_domain_admin())])
async def revoke_token(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
):
    async with _audit_context(
        request, session, pool, "join.token.revoke", object_type="join_token"
    ) as entry:
        row = await pool.fetchrow("SELECT * FROM join_token WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such token")
        entry.object_dn = row["container_dn"]
        entry.before = {"label": row["label"], "uses_spent": row["uses_spent"]}
        await pool.execute(
            "UPDATE join_token SET revoked_at = now() WHERE id = $1::uuid", id
        )


@router.post("/redeem")
async def redeem(
    body: RedeemRequest,
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Enrol a machine and hand back its own keytab.

    Authenticated by the token alone, so it is throttled per source address
    and every attempt — successful or not — is audited.
    """
    source_ip = client_ip(request)
    throttle_key = f"{REDEEM_THROTTLE_KEY}:{source_ip or 'unknown'}"

    async with pool.acquire() as conn:
        failures = await sessions.recent_failures(
            conn, throttle_key, source_ip, THROTTLE_WINDOW_MINUTES
        )
    if failures >= MAX_REDEEM_FAILURES:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "too many enrolment attempts, try again later",
            headers={"Retry-After": str(THROTTLE_WINDOW_MINUTES * 60)},
        )

    row = await pool.fetchrow(
        """
        SELECT * FROM join_token
        WHERE token_sha256 = $1 AND revoked_at IS NULL AND expires_at > now()
          AND uses_spent < uses_allowed
        """,
        _hash(body.token),
    )
    hostname = body.hostname.strip().lower()
    if row is None or (row["hostname"] and row["hostname"] != hostname):
        await _record_failure(pool, throttle_key, source_ip, hostname)
        raise HTTPException(status.HTTP_403_FORBIDDEN, "invalid or expired enrolment token")

    try:
        keytab = await run_in_threadpool(
            enrolment.provision_machine, settings, hostname, row["container_dn"]
        )
    except enrolment.EnrolmentError:
        await _record_failure(pool, throttle_key, source_ip, hostname)
        raise

    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE join_token
            SET uses_spent = uses_spent + 1, last_used_at = now(), last_used_by = $2
            WHERE id = $1::uuid
            """,
            row["id"],
            hostname,
        )
        await sessions.record_attempt(
            conn, username=throttle_key, source_ip=source_ip, succeeded=True
        )
        await audit.record(
            conn,
            actor=f"enrolment:{hostname}",
            source_ip=source_ip,
            action="join.redeem",
            outcome="success",
            object_type="computer",
            object_dn=f"CN={enrolment.short_name(hostname)},{row['container_dn']}",
            detail=body.operating_system or None,
        )

    return {
        "realm": settings.realm,
        "domain": settings.domain,
        "container_dn": row["container_dn"],
        "keytab": base64.b64encode(keytab).decode("ascii"),
        "service_principal": f"{settings.service_name}/{_console_host(request)}",
        "api_url": str(request.base_url).rstrip("/"),
        "agent_refresh_minutes": settings.agent_refresh_minutes,
    }


def _console_host(request: Request) -> str:
    return request.url.hostname or ""


async def _record_failure(
    pool: asyncpg.Pool, throttle_key: str, source_ip: str | None, hostname: str
) -> None:
    async with pool.acquire() as conn:
        await sessions.record_attempt(
            conn,
            username=throttle_key,
            source_ip=source_ip,
            succeeded=False,
            reason="enrolment refused",
        )
        await audit.record(
            conn,
            actor=f"enrolment:{hostname}",
            source_ip=source_ip,
            action="join.redeem",
            outcome="denied",
            object_type="computer",
            detail="invalid, expired or exhausted enrolment token",
        )
