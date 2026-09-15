"""Where a phone sends its answer.

Unauthenticated on purpose: the phone has no session and no keytab, and
the only thing that proves the tap came from the right phone is that the
right phone is the only place the token was ever sent. Everything else
about the request is ignored — no body, no query, no headers are read. A
token answers exactly one question, once, and only while that question is
still open.
"""

from __future__ import annotations

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import PlainTextResponse

from . import audit
from .security import get_pool

router = APIRouter(prefix="/api/v1/push", tags=["push"])

# Both verbs, because ntfy's http action posts and a person who opens the
# link some other way gets, and neither should be told "method not allowed"
# by a factor they are in the middle of using.
_METHODS = ["POST", "GET"]


async def _answer(request: Request, pool: asyncpg.Pool, token: str, decision: str) -> str:
    async with pool.acquire() as conn:
        # Single use and still open: the UPDATE matches only an undecided,
        # unexpired challenge, so a second tap or a late tap changes nothing.
        row = await conn.fetchrow(
            """
            UPDATE push_challenge
            SET decision = $2, decided_at = now()
            WHERE token = $1 AND decision IS NULL AND expires_at > now()
            RETURNING principal, principal_sid, machine_dn, hostname, service
            """,
            token,
            decision,
        )
        if row is None:
            # A phone confirming its own enrolment uses the same button and
            # the same token shape; see auth.py.
            enrolled = await conn.fetchrow(
                """
                UPDATE push_enrolment
                SET confirmed_at = now(), updated_at = now()
                WHERE confirm_token = $1 AND confirmed_at IS NULL AND $2 = 'approved'
                RETURNING principal, principal_sid
                """,
                token,
                decision,
            )
            if enrolled is None:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND,
                    "this request has already been answered or has expired",
                )
            await audit.record(
                conn,
                actor=enrolled["principal"],
                actor_sid=enrolled["principal_sid"],
                source_ip=request.client.host if request.client else None,
                action="auth.second_factor.push.enrol",
                outcome="success",
                object_type="session",
                detail="a phone was confirmed for sign-in approvals",
            )
            return "This phone is set up. You can close this."
        await audit.record(
            conn,
            actor=row["principal"],
            actor_sid=row["principal_sid"],
            source_ip=request.client.host if request.client else None,
            action=f"auth.second_factor.push.{decision}",
            outcome="success" if decision == "approved" else "denied",
            object_type="session",
            object_dn=row["machine_dn"],
            detail=f"{row['service']} sign-in at {row['hostname']} {decision} from the phone",
        )
    return "Approved. You can close this." if decision == "approved" else "Denied."


@router.api_route("/{token}/approve", methods=_METHODS, response_class=PlainTextResponse)
async def approve(
    token: str, request: Request, pool: asyncpg.Pool = Depends(get_pool)
) -> str:
    return await _answer(request, pool, token, "approved")


@router.api_route("/{token}/deny", methods=_METHODS, response_class=PlainTextResponse)
async def deny(token: str, request: Request, pool: asyncpg.Pool = Depends(get_pool)) -> str:
    return await _answer(request, pool, token, "denied")
