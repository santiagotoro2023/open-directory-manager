"""Audit trail writes.

Every state change in ODM goes through here. audit_log is append-only at the
database level, so this module only ever inserts.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import asyncpg

from .objects import NotFound, ObjectError, ProtectedObject


async def record(
    conn: asyncpg.Connection,
    *,
    actor: str,
    action: str,
    outcome: str,
    actor_sid: str | None = None,
    source_ip: str | None = None,
    object_type: str | None = None,
    object_dn: str | None = None,
    detail: str | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
) -> None:
    if outcome not in ("success", "failure", "denied"):
        raise ValueError(f"invalid audit outcome: {outcome!r}")
    await conn.execute(
        """
        INSERT INTO audit_log (actor, actor_sid, source_ip, action, object_type,
                               object_dn, outcome, detail, before_state, after_state)
        VALUES ($1, $2, $3::inet, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
        """,
        actor,
        actor_sid,
        source_ip,
        action,
        object_type,
        object_dn,
        outcome,
        detail,
        _json(before),
        _json(after),
    )


def _json(state: dict[str, Any] | None) -> str | None:
    """Serialise a before/after state, whatever the caller handed us.

    Callers pass rows straight from the database and objects straight from the
    directory, and those carry datetimes, UUIDs and IP addresses. json.dumps
    refuses them, and it refused them from inside the audit write — after the
    operation itself had already succeeded, so the change was made and the
    request still answered 500. Saving a group policy object did exactly that.

    default=str because this is a record of what happened, not a wire format:
    a timestamp written as its ISO string is worth more than an exception.
    """
    if state is None:
        return None
    return json.dumps(state, default=str)


@dataclass
class Entry:
    """Filled in by the caller while the operation runs."""

    object_dn: str | None = None
    object_type: str | None = None
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    detail: str | None = None


@asynccontextmanager
async def audited(
    pool: asyncpg.Pool,
    *,
    actor: str,
    actor_sid: str | None,
    source_ip: str | None,
    action: str,
    object_type: str | None = None,
    object_dn: str | None = None,
):
    """Wrap a write so it is audited whether it succeeds or is refused.

    A refused delete of a protected object is exactly the kind of event this
    log exists to surface, so failures are recorded too (CLAUDE.md §6).
    """
    entry = Entry(object_dn=object_dn, object_type=object_type)
    try:
        yield entry
    except Exception as exc:
        refused = isinstance(exc, NotFound | ObjectError | ProtectedObject)
        outcome = "denied" if refused else "failure"
        async with pool.acquire() as conn:
            await record(
                conn,
                actor=actor,
                actor_sid=actor_sid,
                source_ip=source_ip,
                action=action,
                outcome=outcome,
                object_type=entry.object_type,
                object_dn=entry.object_dn,
                detail=str(exc)[:500],
            )
        raise
    async with pool.acquire() as conn:
        await record(
            conn,
            actor=actor,
            actor_sid=actor_sid,
            source_ip=source_ip,
            action=action,
            outcome="success",
            object_type=entry.object_type,
            object_dn=entry.object_dn,
            detail=entry.detail,
            before=entry.before,
            after=entry.after,
        )
