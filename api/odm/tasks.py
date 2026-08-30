"""Work queued for a machine that is not this one.

The control plane can only run a subprocess on its own host. Everything it
needs done elsewhere — installing a role on a member server, rendering a
share — is queued here and collected by that machine's agent, which already
proves who it is with the Kerberos identity domain join gave it.

A task is claimed by exactly one poll, so a slow install is not started
twice by an agent that polls again while it runs.
"""

from __future__ import annotations

import json
from typing import Any

import asyncpg

KINDS = (
    "role-install",
    "console-certificate",
    "share-apply",
    "share-remove",
    "update-check",
    "update-install",
    "package-install",
    "package-remove",
    "policy-refresh",
    "restart",
    "shutdown",
    "printer-apply",
    "printer-remove",
    "vpn-apply",
    "radius-apply",
)


async def enqueue(
    conn: asyncpg.Connection,
    *,
    node_fqdn: str,
    kind: str,
    payload: dict[str, Any],
    subject: str | None = None,
    requested_by: str | None = None,
) -> str:
    if kind not in KINDS:
        raise ValueError(f"unknown task kind {kind!r}")
    row = await conn.fetchrow(
        """
        INSERT INTO node_task (node_fqdn, kind, payload, subject, requested_by)
        VALUES ($1, $2, $3::jsonb, $4, $5)
        RETURNING id
        """,
        node_fqdn,
        kind,
        json.dumps(payload),
        subject,
        requested_by,
    )
    return str(row["id"])


async def claim(conn: asyncpg.Connection, node_fqdn: str, limit: int = 5) -> list[dict[str, Any]]:
    """Hand this machine its pending work, marking it taken in the same step."""
    rows = await conn.fetch(
        """
        UPDATE node_task SET state = 'claimed', claimed_at = now()
        WHERE id IN (
            SELECT id FROM node_task
            WHERE lower(node_fqdn) = lower($1) AND state = 'pending'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $2
        )
        RETURNING id, kind, payload
        """,
        node_fqdn,
        limit,
    )
    return [
        {"id": str(row["id"]), "kind": row["kind"], "payload": json.loads(row["payload"])}
        for row in rows
    ]


async def finish(
    conn: asyncpg.Connection, task_id: str, node_fqdn: str, *, ok: bool, output: str
) -> dict[str, Any] | None:
    """Record an outcome, but only for the machine the task belongs to."""
    row = await conn.fetchrow(
        """
        UPDATE node_task
        SET state = $3, output = $4, finished_at = now()
        WHERE id = $1::uuid AND lower(node_fqdn) = lower($2) AND state = 'claimed'
        RETURNING id, kind, subject
        """,
        task_id,
        node_fqdn,
        "done" if ok else "failed",
        output[:4000],
    )
    if row is None:
        return None
    return {"id": str(row["id"]), "kind": row["kind"], "subject": row["subject"]}
