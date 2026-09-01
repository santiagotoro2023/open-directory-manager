"""Deleted-object retention and restore (CLAUDE.md §3.9, §5.3).

Deletes snapshot the whole object plus its linked attributes into PostgreSQL
before the directory delete runs, so restore is a database read and a
directory add, not a dependency on tombstone fidelity. A background job
purges anything past the retention window.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import audit, objects
from .config import Settings, get_settings
from .routes_directory import _audit_context, _bound
from .security import get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/recyclebin", tags=["recyclebin"])

PURGE_INTERVAL_SECONDS = 3600


class RestoreRequest(BaseModel):
    id: Annotated[str, Field(min_length=36, max_length=36)]
    # Where to put it back. Empty means where it came from; an object whose
    # container was deleted after it was has to be restorable somewhere.
    container: Annotated[str | None, Field(default=None, max_length=1024)] = None


def _row(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "object_dn": row["object_dn"],
        "object_type": row["object_type"],
        "display_name": row["display_name"],
        "parent_dn": row["parent_dn"],
        "deleted_by": row["deleted_by"],
        "deleted_at": row["deleted_at"],
        "purge_after": row["purge_after"],
        "restored_at": row["restored_at"],
        "memberships": json.loads(row["memberships"]),
        "members": json.loads(row["members"]),
    }


@router.get("", dependencies=[Depends(requires("recyclebin.read"))])
async def list_deleted(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
    query: Annotated[str | None, Query(max_length=256)] = None,
    object_type: Annotated[str | None, Query(max_length=32)] = None,
    include_restored: bool = False,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT * FROM deleted_object
        WHERE purged_at IS NULL
          AND ($1::boolean OR restored_at IS NULL)
          AND ($2::text IS NULL OR object_dn ILIKE '%' || $2 || '%'
               OR display_name ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR object_type = $3)
        ORDER BY deleted_at DESC
        LIMIT $4
        """,
        include_restored,
        query,
        object_type,
        limit,
    )
    return {"items": [_row(row) for row in rows], "retention_days": settings.retention_days}


@router.get("/item", dependencies=[Depends(requires("recyclebin.read"))])
async def read_deleted(
    id: Annotated[str, Query(min_length=36, max_length=36)],
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    row = await pool.fetchrow("SELECT * FROM deleted_object WHERE id = $1::uuid", id)
    if row is None:
        raise objects.NotFound("no such deleted object")
    return {**_row(row), "attributes": json.loads(row["attributes"])}


@router.post("/restore", dependencies=[Depends(requires("recyclebin.restore"))])
async def restore(
    body: RestoreRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Recreate the object and rejoin the groups it belonged to."""
    async with _audit_context(
        request, session, pool, "recyclebin.restore", object_type="recyclebin"
    ) as entry:
        row = await pool.fetchrow(
            "SELECT * FROM deleted_object WHERE id = $1::uuid AND purged_at IS NULL", body.id
        )
        if row is None:
            raise objects.NotFound("no such deleted object")
        if row["restored_at"] is not None:
            raise objects.ObjectError("this object has already been restored")

        snapshot = {
            "object_dn": row["object_dn"],
            "parent_dn": row["parent_dn"],
            "attributes": json.loads(row["attributes"]),
            "memberships": json.loads(row["memberships"]),
            "members": json.loads(row["members"]),
        }
        entry.object_dn = row["object_dn"]
        entry.object_type = row["object_type"]

        async with _bound(settings, write=True) as conn:
            dn = await run_in_threadpool(
                objects.restore, conn, settings, snapshot, body.container
            )
            restored = await run_in_threadpool(objects.get, conn, settings, dn)

        await pool.execute(
            "UPDATE deleted_object SET restored_at = now(), restored_by = $2 WHERE id = $1::uuid",
            body.id,
            session.principal,
        )
        entry.after = restored
        entry.detail = "restored with a new SID; re-grant any access that named the old one"
        return restored


@router.delete("/item", status_code=204, dependencies=[Depends(requires("recyclebin.purge"))])
async def purge(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Purge one snapshot now, before its retention window is up."""
    async with _audit_context(
        request, session, pool, "recyclebin.purge", object_type="recyclebin"
    ) as entry:
        row = await pool.fetchrow("SELECT * FROM deleted_object WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such deleted object")
        entry.object_dn = row["object_dn"]
        entry.before = {"deleted_at": str(row["deleted_at"]), "object_type": row["object_type"]}
        # The row is kept as a tombstone of the purge itself; the snapshot,
        # which is the part holding directory data, is dropped.
        await pool.execute(
            """
            UPDATE deleted_object
            SET purged_at = now(), attributes = '{}'::jsonb,
                memberships = '[]'::jsonb, members = '[]'::jsonb
            WHERE id = $1::uuid
            """,
            id,
        )


async def purge_expired(pool: asyncpg.Pool) -> int:
    """Drop snapshots past their retention window."""
    rows = await pool.fetch(
        """
        UPDATE deleted_object
        SET purged_at = now(), attributes = '{}'::jsonb,
            memberships = '[]'::jsonb, members = '[]'::jsonb
        WHERE purged_at IS NULL AND restored_at IS NULL AND purge_after < now()
        RETURNING object_dn, object_type
        """
    )
    if rows:
        async with pool.acquire() as conn:
            for row in rows:
                await audit.record(
                    conn,
                    actor="system",
                    action="recyclebin.purge",
                    outcome="success",
                    object_type=row["object_type"],
                    object_dn=row["object_dn"],
                    detail="retention window elapsed",
                )
    return len(rows)


async def purge_loop(pool: asyncpg.Pool) -> None:
    """Hourly retention sweep, started with the application."""
    while True:
        with contextlib.suppress(Exception):
            # A failed sweep must never take the API down; the next one runs
            # in an hour and the rows are still there.
            await purge_expired(pool)
        await asyncio.sleep(PURGE_INTERVAL_SECONDS)
