"""Audit log viewer.

Read-only by construction: audit_log is append-only in the database, and
there is no endpoint that writes to it directly.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Annotated, Any, Literal

import asyncpg
from fastapi import APIRouter, Depends, Query

from .security import get_pool, require_admin
from .sessions import Session

router = APIRouter(prefix="/api/v1/audit", tags=["audit"])


@router.get("")
async def list_audit(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    actor: Annotated[str | None, Query(max_length=256)] = None,
    action: Annotated[str | None, Query(max_length=64)] = None,
    object_dn: Annotated[str | None, Query(max_length=1024)] = None,
    outcome: Literal["success", "failure", "denied"] | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT id, occurred_at, actor, source_ip, action, object_type, object_dn,
               outcome, detail, before_state, after_state
        FROM audit_log
        WHERE ($1::text IS NULL OR actor ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR action = $2)
          AND ($3::text IS NULL OR object_dn ILIKE '%' || $3 || '%')
          AND ($4::text IS NULL OR outcome = $4)
          AND ($5::timestamptz IS NULL OR occurred_at >= $5)
          AND ($6::timestamptz IS NULL OR occurred_at <= $6)
        ORDER BY occurred_at DESC, id DESC
        LIMIT $7 OFFSET $8
        """,
        actor,
        action,
        object_dn,
        outcome,
        since,
        until,
        limit,
        offset,
    )
    return {
        "entries": [
            {
                **dict(row),
                "id": str(row["id"]),
                "source_ip": str(row["source_ip"]) if row["source_ip"] else None,
                "before_state": json.loads(row["before_state"]) if row["before_state"] else None,
                "after_state": json.loads(row["after_state"]) if row["after_state"] else None,
            }
            for row in rows
        ],
        "limit": limit,
        "offset": offset,
    }


@router.get("/actions")
async def known_actions(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> list[str]:
    """Distinct actions seen so far, for the filter dropdown."""
    rows = await pool.fetch("SELECT DISTINCT action FROM audit_log ORDER BY action")
    return [row["action"] for row in rows]
