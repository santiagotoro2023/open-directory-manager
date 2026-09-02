"""File shares: what is shared, from which server, and who may reach it."""

from __future__ import annotations

import json
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from . import audit, objects, shares, tasks
from .security import client_ip, get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/shares", tags=["shares"])


class EntryIn(BaseModel):
    principal: Annotated[str, Field(min_length=1, max_length=64)]
    kind: Annotated[str, Field(pattern="^(user|group)$")] = "group"
    access: Annotated[str, Field(pattern="^(read|change|full)$")] = "read"
    inherit: bool = True


class ShareIn(BaseModel):
    node_fqdn: Annotated[str, Field(min_length=1, max_length=253)]
    name: Annotated[str, Field(min_length=1, max_length=63)]
    path: Annotated[str, Field(min_length=2, max_length=255)]
    comment: Annotated[str, Field(max_length=255)] = ""
    owner: Annotated[str, Field(max_length=64)] = "root"
    owner_group: Annotated[str, Field(max_length=64)] = "Domain Admins"
    entries: list[EntryIn] = Field(default_factory=list)
    browseable: bool = True
    read_only: bool = False


class ShareUpdate(BaseModel):
    id: Annotated[str, Field(min_length=36, max_length=36)]
    comment: Annotated[str, Field(max_length=255)] | None = None
    owner: Annotated[str, Field(max_length=64)] | None = None
    owner_group: Annotated[str, Field(max_length=64)] | None = None
    entries: list[EntryIn] | None = None
    browseable: bool | None = None
    read_only: bool | None = None


def _json(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "node_fqdn": row["node_fqdn"],
        "name": row["name"],
        "path": row["path"],
        "comment": row["comment"],
        "owner": row["owner"],
        "owner_group": row["owner_group"],
        "entries": json.loads(row["entries"]),
        "browseable": row["browseable"],
        "read_only": row["read_only"],
        "state": row["state"],
        "last_error": row["last_error"],
        "unc": f"//{row['node_fqdn']}/{row['name']}",
        "updated_at": row["updated_at"],
    }


async def _dispatch(conn: asyncpg.Connection, row: asyncpg.Record, actor: str) -> None:
    """Queue the node's agent to make the stored definition real."""
    await conn.execute("UPDATE file_share SET state = 'applying' WHERE id = $1", row["id"])
    await tasks.enqueue(
        conn,
        node_fqdn=row["node_fqdn"],
        kind="share-apply",
        payload=shares.as_task(dict(row)),
        subject=str(row["id"]),
        requested_by=actor,
    )


@router.get("", dependencies=[Depends(requires("share.read"))])
async def list_shares(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    rows = await pool.fetch("SELECT * FROM file_share ORDER BY node_fqdn, name")
    return {"shares": [_json(row) for row in rows], "access_levels": shares.ACCESS_LABELS}


@router.post("", status_code=201, dependencies=[Depends(requires("share.write"))])
async def create_share(
    body: ShareIn,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    name = shares.validate_name(body.name)
    path = shares.validate_path(body.path)
    entries = shares.validate_entries([entry.model_dump() for entry in body.entries])

    async with pool.acquire() as conn:
        existing = await conn.fetchval(
            "SELECT 1 FROM file_share"
            " WHERE lower(node_fqdn) = lower($1) AND lower(name) = lower($2)",
            body.node_fqdn,
            name,
        )
        if existing:
            raise objects.ObjectError(f"{body.node_fqdn} already shares {name}")
        row = await conn.fetchrow(
            """
            INSERT INTO file_share
                (node_fqdn, name, path, comment, owner, owner_group, entries,
                 browseable, read_only, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
            RETURNING *
            """,
            body.node_fqdn,
            name,
            path,
            body.comment,
            shares.validate_principal(body.owner),
            shares.validate_principal(body.owner_group),
            json.dumps([entry.as_json() for entry in entries]),
            body.browseable,
            body.read_only,
            session.principal,
        )
        await _dispatch(conn, row, session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="share.create",
            outcome="success",
            object_type="share",
            object_dn=f"//{body.node_fqdn}/{name}",
            after=_json(row),
        )
    return _json(row)


@router.patch("", dependencies=[Depends(requires("share.write"))])
async def update_share(
    body: ShareUpdate,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        before = await conn.fetchrow("SELECT * FROM file_share WHERE id = $1::uuid", body.id)
        if before is None:
            raise objects.NotFound("no such share")

        entries = (
            json.dumps(
                [
                    entry.as_json()
                    for entry in shares.validate_entries(
                        [entry.model_dump() for entry in body.entries]
                    )
                ]
            )
            if body.entries is not None
            else None
        )
        row = await conn.fetchrow(
            """
            UPDATE file_share SET
                comment     = COALESCE($2, comment),
                owner       = COALESCE($3, owner),
                owner_group = COALESCE($4, owner_group),
                entries     = COALESCE($5::jsonb, entries),
                browseable  = COALESCE($6, browseable),
                read_only   = COALESCE($7, read_only),
                updated_at  = now()
            WHERE id = $1::uuid
            RETURNING *
            """,
            body.id,
            body.comment,
            shares.validate_principal(body.owner) if body.owner is not None else None,
            shares.validate_principal(body.owner_group) if body.owner_group is not None else None,
            entries,
            body.browseable,
            body.read_only,
        )
        await _dispatch(conn, row, session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="share.update",
            outcome="success",
            object_type="share",
            object_dn=f"//{row['node_fqdn']}/{row['name']}",
            before=_json(before),
            after=_json(row),
        )
    return _json(row)


@router.delete("", status_code=204, dependencies=[Depends(requires("share.write"))])
async def delete_share(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    contents: Annotated[bool, Query()] = False,
) -> None:
    """Stop sharing the directory, and delete it too when asked.

    Two different intentions: withdrawing a share, and being rid of what it
    held. The directory stays unless contents says otherwise.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM file_share WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such share")
        await tasks.enqueue(
            conn,
            node_fqdn=row["node_fqdn"],
            kind="share-remove",
            payload={"name": row["name"], "path": row["path"], "contents": contents},
            subject=str(row["id"]),
            requested_by=session.principal,
        )
        await conn.execute("DELETE FROM file_share WHERE id = $1::uuid", id)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="share.delete",
            outcome="success",
            object_type="share",
            object_dn=f"//{row['node_fqdn']}/{row['name']}",
            before=_json(row),
            detail=(
                f"{row['path']} and everything in it was deleted"
                if contents
                else "the directory and its contents are left in place"
            ),
        )
