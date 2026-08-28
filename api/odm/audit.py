"""Audit trail writes.

Every state change in ODM goes through here. audit_log is append-only at the
database level, so this module only ever inserts.
"""

from __future__ import annotations

import json
from typing import Any

import asyncpg


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
        json.dumps(before) if before is not None else None,
        json.dumps(after) if after is not None else None,
    )
