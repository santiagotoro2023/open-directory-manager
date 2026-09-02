"""Work queued for a machine that is not this one.

The control plane can only run a subprocess on its own host. Everything it
needs done elsewhere — installing a role on a member server, rendering a
share — is queued here and collected by that machine's agent, which already
proves who it is with the Kerberos identity domain join gave it.

A task is claimed by exactly one poll, so a slow install is not started
twice by an agent that polls again while it runs.
"""

from __future__ import annotations

import asyncio
import json
import time
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
    "browse",
    "printer-discover",
    "domain-backup",
    "make-directory",
    "local-user-add",
    "local-user-remove",
    "policy-refresh",
    "restart",
    "shutdown",
    "printer-apply",
    "printer-remove",
    "printer-test",
    "vpn-apply",
    "radius-apply",
    "rd-host-apply",
    "rd-broker-apply",
)


async def push_policy(conn: asyncpg.Connection | asyncpg.Pool, requested_by: str) -> int:
    """Tell every machine that its policy may have changed.

    Only when the domain is set to push. The agent already holds a request
    open for queued work, so a refresh reaches it within a second; without
    this it finds out at its next poll. Queued for machines that have
    reported, and skipped where one is already waiting, so a run of edits does
    not leave a machine with a queue of identical refreshes to work through.
    """
    schedule = await conn.fetchrow("SELECT push_enabled FROM agent_schedule")
    if schedule is None or not schedule["push_enabled"]:
        return 0
    rows = await conn.fetch(
        """
        SELECT hostname FROM computer_fact
        WHERE NOT EXISTS (
            SELECT 1 FROM node_task
            WHERE lower(node_task.node_fqdn) = lower(computer_fact.hostname)
              AND node_task.kind = 'policy-refresh'
              AND node_task.state IN ('pending', 'claimed')
        )
        """
    )
    for row in rows:
        await enqueue(
            conn,
            node_fqdn=row["hostname"],
            kind="policy-refresh",
            payload={"reason": "policy changed"},
            requested_by=requested_by,
        )
    return len(rows)


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


# How long a task may sit before nobody is coming for it. The agent bounds
# its own longest task — a role install — at 30 minutes, so a claimed task
# older than this is not still running: the agent restarted, or the machine
# went away underneath it.
STALE_MINUTES = 45


async def reap(conn: asyncpg.Connection) -> None:
    """Fail tasks nobody is going to finish, and release what waited on them.

    Without this a role whose machine stopped reporting says "installing" for
    ever, with no way to retry it and nothing on screen saying why.
    """
    rows = await conn.fetch(
        """
        UPDATE node_task
        SET state = 'failed', finished_at = now(), payload = payload - 'password',
            output = CASE WHEN state = 'claimed'
                THEN 'The machine stopped reporting before this finished.'
                ELSE 'No agent on this machine collected this. Is odm-agent '
                     'installed and running there?'
            END
        WHERE state IN ('pending', 'claimed')
          AND coalesce(claimed_at, created_at) < now() - ($1 * interval '1 minute')
        RETURNING kind, subject, output
        """,
        STALE_MINUTES,
    )
    # Written out rather than interpolated: an identity system does not build
    # SQL from a value, even one it chose itself.
    for row in rows:
        if not row["subject"]:
            continue
        if row["kind"] == "role-install":
            statement = """
                UPDATE server_role SET state = 'failed', last_error = $2, updated_at = now()
                WHERE id = $1::uuid AND state = 'installing'
            """
        elif row["kind"] == "share-apply":
            statement = """
                UPDATE file_share SET state = 'failed', last_error = $2, updated_at = now()
                WHERE id = $1::uuid AND state = 'installing'
            """
        else:
            continue
        await conn.execute(statement, row["subject"], row["output"])


async def claim(conn: asyncpg.Connection, node_fqdn: str, limit: int = 1) -> list[dict[str, Any]]:
    """Hand this machine its pending work, marking it taken in the same step.

    One at a time by default. The agent runs tasks serially, so handing it
    five made four of them say "claimed" — and four roles say "installing" —
    while one machine installed one thing.
    """
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
        -- A task can carry a password for the machine to set. It is needed
        -- until the machine has it and never after, so it does not outlive
        -- the task in the queue.
        SET state = $3, output = $4, finished_at = now(), payload = payload - 'password'
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


async def run_now(
    pool: Any,
    *,
    node_fqdn: str,
    kind: str,
    payload: dict[str, Any],
    requested_by: str,
    timeout: float = 20.0,
) -> str:
    """Queue a task and wait for its answer.

    Only for the small, interactive ones — listing a directory while somebody
    chooses where a share goes. The agent holds a request open with the
    control plane, so a queued task starts within about a second; anything
    slower than that belongs in the ordinary fire-and-poll path instead of
    holding a request open here.
    """
    async with pool.acquire() as conn:
        task_id = await enqueue(
            conn, node_fqdn=node_fqdn, kind=kind, payload=payload, requested_by=requested_by
        )

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        await asyncio.sleep(0.4)
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT state, output FROM node_task WHERE id = $1::uuid", task_id
            )
        if row is None or row["state"] in ("pending", "claimed"):
            continue
        if row["state"] == "failed":
            raise TaskFailed(row["output"] or "the machine did not say why")
        return row["output"] or ""

    raise TaskFailed(
        f"{node_fqdn} did not answer within {int(timeout)} seconds. Its agent runs one "
        "thing at a time, so it may be part way through installing something; "
        "otherwise check that odm-agent is running there."
    )


class TaskFailed(Exception):
    """A task the caller was waiting for did not succeed."""
