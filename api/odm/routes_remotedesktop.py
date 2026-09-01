"""Remote desktop: collections, the hosts serving them, and who is connected."""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

import asyncpg
from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field

from . import audit, objects, remotedesktop, tasks
from .security import client_ip, get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/rd", tags=["remote-desktop"])


class CollectionIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=63)]
    description: Annotated[str, Field(max_length=255)] = ""
    broker_fqdn: Annotated[str, Field(min_length=1, max_length=253)]
    kind: Literal["desktop", "remoteapp"] = "desktop"
    app_path: Annotated[str, Field(max_length=255)] = ""
    app_name: Annotated[str, Field(max_length=64)] = ""
    profile_share: Annotated[str, Field(min_length=3, max_length=255)]
    profile_gb: Annotated[int, Field(ge=1, le=2048)] = 10
    idle_minutes: Annotated[int, Field(ge=0, le=10080)] = 60
    disconnected_minutes: Annotated[int, Field(ge=0, le=10080)] = 120
    max_sessions_per_host: Annotated[int, Field(ge=0, le=1000)] = 0
    balance_method: Literal["leastconn", "roundrobin", "first"] = "leastconn"
    principals: Annotated[list[Annotated[str, Field(max_length=512)]], Field(max_length=200)] = []


class CollectionUpdate(BaseModel):
    id: Annotated[str, Field(min_length=36, max_length=36)]
    description: Annotated[str, Field(max_length=255)] | None = None
    broker_fqdn: Annotated[str, Field(max_length=253)] | None = None
    kind: Literal["desktop", "remoteapp"] | None = None
    app_path: Annotated[str, Field(max_length=255)] | None = None
    app_name: Annotated[str, Field(max_length=64)] | None = None
    profile_share: Annotated[str, Field(max_length=255)] | None = None
    profile_gb: Annotated[int, Field(ge=1, le=2048)] | None = None
    idle_minutes: Annotated[int, Field(ge=0, le=10080)] | None = None
    disconnected_minutes: Annotated[int, Field(ge=0, le=10080)] | None = None
    max_sessions_per_host: Annotated[int, Field(ge=0, le=1000)] | None = None
    balance_method: Literal["leastconn", "roundrobin", "first"] | None = None
    principals: (
        Annotated[list[Annotated[str, Field(max_length=512)]], Field(max_length=200)] | None
    ) = None


class HostIn(BaseModel):
    collection_id: Annotated[str, Field(min_length=36, max_length=36)]
    node_fqdn: Annotated[str, Field(min_length=1, max_length=253)]


def _collection_json(row: asyncpg.Record, hosts: list[str]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "broker_fqdn": row["broker_fqdn"],
        "kind": row["kind"],
        "app_path": row["app_path"],
        "app_name": row["app_name"],
        "profile_share": row["profile_share"],
        "profile_gb": row["profile_gb"],
        "idle_minutes": row["idle_minutes"],
        "disconnected_minutes": row["disconnected_minutes"],
        "max_sessions_per_host": row["max_sessions_per_host"],
        "balance_method": row["balance_method"],
        "principals": json.loads(row["principals"]),
        "hosts": hosts,
        "state": row["state"],
        "last_error": row["last_error"],
        "updated_at": row["updated_at"],
    }


async def _hosts_of(conn: asyncpg.Connection, collection_id: Any) -> list[str]:
    rows = await conn.fetch(
        "SELECT node_fqdn FROM rd_collection_host WHERE collection_id = $1 ORDER BY node_fqdn",
        collection_id,
    )
    return [row["node_fqdn"] for row in rows]


async def _dispatch(conn: asyncpg.Connection, row: asyncpg.Record, actor: str) -> None:
    """Tell the broker where to send people, and every host what to serve.

    Both sides on every change, because a collection is one thing: a host that
    still has last week's profile share while the broker sends people to it is
    worse than one that has nothing.
    """
    hosts = await _hosts_of(conn, row["id"])
    await conn.execute(
        "UPDATE rd_collection SET state = 'applying', updated_at = now() WHERE id = $1",
        row["id"],
    )
    # Hosts first, then the broker. A host that shares a machine with the
    # broker has to move xrdp off 3389 before haproxy can take it; the other
    # way round the broker found the port busy and gave up.
    for host in hosts:
        await tasks.enqueue(
            conn,
            node_fqdn=host,
            kind="rd-host-apply",
            payload=remotedesktop.host_task(dict(row), host),
            subject=str(row["id"]),
            requested_by=actor,
        )
    await tasks.enqueue(
        conn,
        node_fqdn=row["broker_fqdn"],
        kind="rd-broker-apply",
        payload=remotedesktop.broker_task(dict(row), hosts),
        subject=str(row["id"]),
        requested_by=actor,
    )


@router.get("", dependencies=[Depends(requires("rd.read"))])
async def list_collections(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM rd_collection ORDER BY name")
        collections = [
            _collection_json(row, await _hosts_of(conn, row["id"])) for row in rows
        ]
        # Hosts carrying the role that are not in any collection: they serve
        # nobody, and that is worth seeing rather than discovering later.
        unassigned = await conn.fetch(
            """
            SELECT r.node_fqdn FROM server_role r
            LEFT JOIN rd_collection_host h ON lower(h.node_fqdn) = lower(r.node_fqdn)
            WHERE r.role_name = 'session-host' AND r.state = 'active'
              AND h.node_fqdn IS NULL
            ORDER BY r.node_fqdn
            """
        )
    return {
        "collections": collections,
        "unassigned_hosts": [row["node_fqdn"] for row in unassigned],
    }


@router.get("/sessions", dependencies=[Depends(requires("rd.read"))])
async def list_sessions(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Who is on which host, as the hosts last reported it."""
    rows = await pool.fetch(
        "SELECT * FROM rd_session ORDER BY reported_at DESC, username LIMIT 500"
    )
    return {"sessions": [dict(row) for row in rows]}


@router.post("", status_code=201, dependencies=[Depends(requires("rd.write"))])
async def create_collection(
    body: CollectionIn,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    name = remotedesktop.validate_name(body.name)
    share = remotedesktop.validate_share(body.profile_share)
    app_path = remotedesktop.validate_app(body.kind, body.app_path)

    async with pool.acquire() as conn:
        taken = await conn.fetchval(
            "SELECT 1 FROM rd_collection WHERE lower(name) = lower($1)", name
        )
        if taken:
            raise objects.ObjectError(f"a collection named {name!r} already exists")
        row = await conn.fetchrow(
            """
            INSERT INTO rd_collection (name, description, broker_fqdn, kind, app_path,
                                       app_name, profile_share, profile_gb, idle_minutes,
                                       disconnected_minutes, max_sessions_per_host,
                                       balance_method, principals, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
            RETURNING *
            """,
            name,
            body.description,
            body.broker_fqdn,
            body.kind,
            app_path,
            body.app_name,
            share,
            body.profile_gb,
            body.idle_minutes,
            body.disconnected_minutes,
            body.max_sessions_per_host,
            body.balance_method,
            json.dumps(body.principals),
            session.principal,
        )
        await _dispatch(conn, row, session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="rd.collection.create",
            outcome="success",
            object_type="rd_collection",
            object_dn=name,
            after=_collection_json(row, []),
        )
        return _collection_json(row, [])


@router.patch("", dependencies=[Depends(requires("rd.write"))])
async def update_collection(
    body: CollectionUpdate,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM rd_collection WHERE id = $1::uuid", body.id)
        if row is None:
            raise objects.NotFound("no such collection")
        before = _collection_json(row, await _hosts_of(conn, row["id"]))

        share = (
            remotedesktop.validate_share(body.profile_share)
            if body.profile_share is not None
            else None
        )
        kind = body.kind if body.kind is not None else row["kind"]
        app_path = (
            remotedesktop.validate_app(kind, body.app_path)
            if body.app_path is not None or body.kind is not None
            else None
        )

        updated = await conn.fetchrow(
            """
            UPDATE rd_collection SET
                description           = COALESCE($2, description),
                broker_fqdn           = COALESCE($3, broker_fqdn),
                kind                  = COALESCE($4, kind),
                app_path              = COALESCE($5, app_path),
                app_name              = COALESCE($6, app_name),
                profile_share         = COALESCE($7, profile_share),
                profile_gb            = COALESCE($8, profile_gb),
                idle_minutes          = COALESCE($9, idle_minutes),
                disconnected_minutes  = COALESCE($10, disconnected_minutes),
                max_sessions_per_host = COALESCE($11, max_sessions_per_host),
                balance_method        = COALESCE($12, balance_method),
                principals            = COALESCE($13::jsonb, principals),
                updated_at            = now()
            WHERE id = $1::uuid
            RETURNING *
            """,
            body.id,
            body.description,
            body.broker_fqdn,
            body.kind,
            app_path,
            body.app_name,
            share,
            body.profile_gb,
            body.idle_minutes,
            body.disconnected_minutes,
            body.max_sessions_per_host,
            body.balance_method,
            None if body.principals is None else json.dumps(body.principals),
        )
        await _dispatch(conn, updated, session.principal)
        hosts = await _hosts_of(conn, updated["id"])
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="rd.collection.update",
            outcome="success",
            object_type="rd_collection",
            object_dn=updated["name"],
            before=before,
            after=_collection_json(updated, hosts),
        )
        return _collection_json(updated, hosts)


@router.delete("", status_code=204, dependencies=[Depends(requires("rd.write"))])
async def delete_collection(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM rd_collection WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such collection")
        # The broker is told first, so nobody is sent to a host that is about
        # to stop serving them.
        await tasks.enqueue(
            conn,
            node_fqdn=row["broker_fqdn"],
            kind="rd-broker-apply",
            payload=remotedesktop.broker_task(dict(row), []),
            subject=str(row["id"]),
            requested_by=session.principal,
        )
        await conn.execute("DELETE FROM rd_collection WHERE id = $1::uuid", id)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="rd.collection.delete",
            outcome="success",
            object_type="rd_collection",
            object_dn=row["name"],
            before=_collection_json(row, []),
        )


@router.post("/hosts", status_code=201, dependencies=[Depends(requires("rd.write"))])
async def add_host(
    body: HostIn,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM rd_collection WHERE id = $1::uuid", body.collection_id
        )
        if row is None:
            raise objects.NotFound("no such collection")
        # A host serves one collection. Two would share a desktop and a
        # profile share while claiming to be separate.
        elsewhere = await conn.fetchval(
            """
            SELECT c.name FROM rd_collection_host h
            JOIN rd_collection c ON c.id = h.collection_id
            WHERE lower(h.node_fqdn) = lower($1)
            """,
            body.node_fqdn,
        )
        if elsewhere and elsewhere != row["name"]:
            raise objects.ObjectError(
                f"{body.node_fqdn} already serves the {elsewhere} collection"
            )
        await conn.execute(
            """
            INSERT INTO rd_collection_host (collection_id, node_fqdn)
            VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING
            """,
            body.collection_id,
            body.node_fqdn,
        )
        await _dispatch(conn, row, session.principal)
        hosts = await _hosts_of(conn, row["id"])
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="rd.host.add",
            outcome="success",
            object_type="rd_collection",
            object_dn=row["name"],
            after={"node_fqdn": body.node_fqdn},
        )
        return _collection_json(row, hosts)


@router.delete("/hosts", status_code=204, dependencies=[Depends(requires("rd.write"))])
async def remove_host(
    request: Request,
    collection_id: Annotated[str, Query(min_length=36, max_length=36)],
    node_fqdn: Annotated[str, Query(min_length=1, max_length=253)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM rd_collection WHERE id = $1::uuid", collection_id
        )
        if row is None:
            raise objects.NotFound("no such collection")
        await conn.execute(
            """
            DELETE FROM rd_collection_host
            WHERE collection_id = $1::uuid AND lower(node_fqdn) = lower($2)
            """,
            collection_id,
            node_fqdn,
        )
        await _dispatch(conn, row, session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="rd.host.remove",
            outcome="success",
            object_type="rd_collection",
            object_dn=row["name"],
            before={"node_fqdn": node_fqdn},
        )


@router.get("/rdp", dependencies=[Depends(requires("rd.read"))])
async def connection_file(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    username: Annotated[str, Query(min_length=1, max_length=64)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> Response:
    """The .rdp file for one person and one collection.

    It carries the user name, which is not a convenience: an RDP client sends
    it in the first packet and the broker keys its affinity on it. Without it
    somebody lands on whichever host is least busy each time, which is the
    opposite of what a collection is for.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM rd_collection WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such collection")
        hosts = await _hosts_of(conn, row["id"])
        if not hosts:
            raise objects.ObjectError(
                "this collection has no session hosts, so there is nothing to connect to"
            )
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="rd.connection.download",
            outcome="success",
            object_type="rd_collection",
            object_dn=row["name"],
            after={"username": username},
        )

    body = remotedesktop.rdp_file(
        broker=row["broker_fqdn"], username=username, collection=dict(row)
    )
    filename = f"{row['name'].replace(' ', '-')}-{username}.rdp"
    return Response(
        content=body,
        media_type="application/x-rdp",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
