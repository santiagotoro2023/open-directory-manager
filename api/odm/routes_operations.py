"""Replication, backups and the health dashboard (CLAUDE.md §4)."""

from __future__ import annotations

import asyncio
import contextlib
import socket
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import audit, backup, ca, kea, objects, replication, tasks
from .config import Settings, get_settings
from .routes_directory import _audit_context, _bound
from .security import get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1", tags=["operations"])


class ReplicateRequest(BaseModel):
    destination: Annotated[str, Field(min_length=1, max_length=253)]
    source: Annotated[str, Field(min_length=1, max_length=253)]
    naming_context: Annotated[str, Field(min_length=3, max_length=1024)]


# ----------------------------------------------------------- replication ---


@router.get("/replication", dependencies=[Depends(requires("replication.read"))])
async def replication_status(
    settings: Settings = Depends(get_settings),
    server: Annotated[str | None, Query(max_length=253)] = None,
) -> dict[str, Any]:
    """Domain controllers and the state of inbound replication."""
    async with _bound(settings, write=False) as conn:
        dcs = await run_in_threadpool(replication.controllers, conn, settings)
    if len(dcs) < 2:
        return {"controllers": dcs, "healthy": True, "inbound": [], "single": True,
                "server": server or ""}
    status = await run_in_threadpool(replication.status, settings, server)
    return {"controllers": dcs, **status}


@router.post("/replication/replicate", dependencies=[Depends(requires("replication.replicate"))])
async def force_replication(
    body: ReplicateRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Force one replication run between two controllers."""
    async with _audit_context(
        request,
        session,
        pool,
        "replication.replicate",
        object_type="replication",
        object_dn=body.naming_context,
    ) as entry:
        output = await run_in_threadpool(
            replication.replicate, settings, body.destination, body.source, body.naming_context
        )
        entry.after = {"destination": body.destination, "source": body.source}
        return {"output": output.strip()[-2000:]}


# --------------------------------------------------------------- backups ---


@router.get("/backups", dependencies=[Depends(requires("backup.read"))])
async def list_backups(
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    rows = await pool.fetch(
        "SELECT * FROM domain_backup ORDER BY started_at DESC LIMIT 100"
    )
    return {
        "configured": backup.configured(settings),
        "directory": str(settings.backup_dir) if settings.backup_dir else None,
        "interval_hours": settings.backup_interval_hours,
        "keep": settings.backup_keep,
        "history": [{**dict(row), "id": str(row["id"])} for row in rows],
        "archives": await run_in_threadpool(backup.archives, settings),
    }


@router.post("/backups", status_code=202, dependencies=[Depends(requires("backup.write"))])
async def take_backup(
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Start a backup and return immediately; poll /backups for the outcome."""
    if not backup.configured(settings):
        raise objects.ObjectError("no backup directory configured (ODM_BACKUP_DIR is unset)")
    row = await pool.fetchrow(
        "INSERT INTO domain_backup (path, taken_by) VALUES ($1, $2) RETURNING id",
        f"pending:{session.principal}:{asyncio.get_running_loop().time()}",
        session.principal,
    )
    # Queued for this controller's own agent, which is root there. The
    # control plane is not, and an online backup would need directory rights
    # its account deliberately does not hold (CLAUDE.md §6).
    async with pool.acquire() as conn:
        await tasks.enqueue(
            conn,
            node_fqdn=socket.getfqdn(),
            kind="domain-backup",
            payload={"target_dir": str(backup.directory(settings))},
            subject=str(row["id"]),
            requested_by=session.principal,
        )
    return {"id": str(row["id"]), "state": "running"}


async def _run_backup(
    pool: asyncpg.Pool, settings: Settings, backup_id: str, actor: str
) -> None:
    try:
        result = await run_in_threadpool(backup.take, settings)
    except Exception as exc:  # recorded, never raised into a background task
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE domain_backup
                SET state = 'failed', finished_at = now(), detail = $2
                WHERE id = $1::uuid
                """,
                backup_id,
                str(exc)[:2000],
            )
            await audit.record(
                conn,
                actor=actor,
                action="backup.take",
                outcome="failure",
                object_type="backup",
                detail=str(exc)[:500],
            )
        return

    removed = await run_in_threadpool(backup.prune, settings, settings.backup_keep)
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE domain_backup
            SET state = 'complete', finished_at = now(), path = $2, size_bytes = $3
            WHERE id = $1::uuid
            """,
            backup_id,
            result["path"],
            result["size_bytes"],
        )
        if removed:
            await conn.execute(
                "UPDATE domain_backup SET state = 'removed' WHERE path = ANY($1::text[])",
                removed,
            )
        await audit.record(
            conn,
            actor=actor,
            action="backup.take",
            outcome="success",
            object_type="backup",
            object_dn=result["path"],
            detail=f"{result['size_bytes']} bytes; pruned {len(removed)}",
        )


async def backup_loop(pool: asyncpg.Pool, settings: Settings) -> None:
    """Scheduled backups, started with the application."""
    if not backup.configured(settings):
        return
    interval = max(settings.backup_interval_hours, 1) * 3600
    while True:
        await asyncio.sleep(interval)
        with contextlib.suppress(Exception):
            row = await pool.fetchrow(
                "INSERT INTO domain_backup (path, taken_by) VALUES ($1, 'system') RETURNING id",
                f"pending:system:{asyncio.get_running_loop().time()}",
            )
            await _run_backup(pool, settings, str(row["id"]), "system")


# ---------------------------------------------------------------- health ---


@router.get("/health", dependencies=[Depends(requires("health.read"))])
async def health(
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """One view of whether the domain is well.

    Every section degrades independently: a subsystem that is not installed,
    or not reachable, reports that rather than failing the whole dashboard.
    """
    report: dict[str, Any] = {"domain": settings.domain}

    report["directory"] = await _section(_directory_health, settings)
    # A domain with one controller has nothing to replicate, and asking anyway
    # produced a red banner on the dashboard of every new install. The count
    # comes from the directory read just above, so this costs nothing.
    if report["directory"].get("controllers", 0) < 2:
        report["replication"] = {"available": True, "healthy": True, "inbound": [],
                                 "single": True}
    else:
        report["replication"] = await _section(
            lambda: run_in_threadpool(replication.status, settings)
        )
    report["dhcp"] = (
        {"configured": False}
        if not kea.configured(settings)
        else await _section(
            lambda: run_in_threadpool(
                lambda: {"statistics": kea.statistics(settings), "ha": kea.ha_status(settings)}
            )
        )
    )
    report["certificates"] = (
        {"initialised": False}
        if not ca.initialised(settings)
        else await _section(lambda: _certificate_health(pool, settings))
    )
    report["agents"] = await _agent_health(pool, settings)
    report["backups"] = await _backup_health(pool, settings)
    return report


async def _section(builder, *args) -> dict[str, Any]:
    try:
        result = builder(*args) if args else builder()
        return await result if asyncio.iscoroutine(result) else result
    except Exception as exc:
        return {"available": False, "detail": str(exc)[:300]}


async def _directory_health(settings: Settings) -> dict[str, Any]:
    async with _bound(settings, write=False) as conn:
        dcs = await run_in_threadpool(replication.controllers, conn, settings)
    return {"available": True, "controllers": len(dcs), "names": [dc["name"] for dc in dcs]}


async def _certificate_health(pool: asyncpg.Pool, settings: Settings) -> dict[str, Any]:
    described = ca.describe(settings)
    described["expiring_soon"] = await pool.fetchval(
        """
        SELECT count(*) FROM ca_certificate
        WHERE revoked_at IS NULL AND not_after < now() + interval '30 days'
        """
    )
    return described


async def _agent_health(pool: asyncpg.Pool, settings: Settings) -> dict[str, Any]:
    stale_after = max(settings.agent_refresh_minutes * 3, 60)
    row = await pool.fetchrow(
        """
        SELECT count(*) AS total,
               count(*) FILTER (WHERE reported_at > now() - ($1 || ' minutes')::interval)
                   AS fresh,
               coalesce(sum(failures), 0) AS failures
        FROM (
            SELECT DISTINCT ON (computer_dn) computer_dn, reported_at, failures
            FROM agent_report ORDER BY computer_dn, reported_at DESC
        ) latest
        """,
        str(stale_after),
    )
    # A count of failures nobody can turn into a name is a number to worry
    # about and nothing to do about it. The settings themselves come back with
    # it, so the console can say which machine failed at what and why.
    failing = await pool.fetch(
        """
        SELECT latest.hostname, item->>'setting' AS setting, item->>'reason' AS reason
        FROM (
            SELECT DISTINCT ON (computer_dn) hostname, results
            FROM agent_report ORDER BY computer_dn, reported_at DESC
        ) latest, LATERAL jsonb_array_elements(latest.results) item
        WHERE item->>'status' = 'failed'
        ORDER BY latest.hostname
        LIMIT 50
        """
    )
    return {
        "checked_in": row["total"],
        "fresh": row["fresh"],
        "stale": row["total"] - row["fresh"],
        "failing_settings": row["failures"],
        "failing": [dict(entry) for entry in failing],
        "stale_after_minutes": stale_after,
    }


async def _backup_health(pool: asyncpg.Pool, settings: Settings) -> dict[str, Any]:
    if not backup.configured(settings):
        return {"configured": False}
    row = await pool.fetchrow(
        """
        SELECT started_at, finished_at, state, size_bytes
        FROM domain_backup WHERE state = 'complete'
        ORDER BY started_at DESC LIMIT 1
        """
    )
    return {
        "configured": True,
        "interval_hours": settings.backup_interval_hours,
        "last": dict(row) if row else None,
    }
