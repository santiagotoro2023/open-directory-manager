"""Network access: RADIUS clients, and who may authenticate where."""

from __future__ import annotations

from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from . import audit, objects, radius, tasks
from .security import client_ip, get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/radius", tags=["radius"])


class ClientIn(BaseModel):
    node_fqdn: Annotated[str, Field(min_length=1, max_length=253)]
    name: Annotated[str, Field(min_length=1, max_length=63)]
    address: Annotated[str, Field(min_length=7, max_length=64)]
    description: Annotated[str, Field(max_length=255)] = ""
    nas_identifier: Annotated[str, Field(max_length=63)] = ""
    # Left empty, one is generated: a secret somebody chose is one somebody
    # could guess, and it is the only thing proving a request came from this
    # device.
    secret: Annotated[str, Field(max_length=128)] = ""


class PolicyIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=63)]
    description: Annotated[str, Field(max_length=255)] = ""
    group_dn: Annotated[str, Field(min_length=3, max_length=1024)]
    group_name: Annotated[str, Field(max_length=128)] = ""
    principal_kind: Annotated[str, Field(pattern="^(user|computer|any)$")] = "user"
    nas_identifiers: list[Annotated[str, Field(max_length=63)]] = Field(default_factory=list)
    access: Annotated[str, Field(pattern="^(allow|deny)$")] = "allow"
    vlan: Annotated[int, Field(ge=1, le=4094)] | None = None
    ordering: Annotated[int, Field(ge=1, le=9999)] = 100
    enabled: bool = True


def _client_json(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "node_fqdn": row["node_fqdn"],
        "name": row["name"],
        "description": row["description"],
        "address": row["address"],
        "nas_identifier": row["nas_identifier"],
        # The secret is what the device proves itself with; it is shown once,
        # when it is created, and never listed afterwards.
        "has_secret": bool(row["secret"]),
        "created_at": row["created_at"],
    }


def _policy_json(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "group_dn": row["group_dn"],
        "group_name": row["group_name"],
        "principal_kind": row["principal_kind"],
        "nas_identifiers": list(row["nas_identifiers"]),
        "access": row["access"],
        "vlan": row["vlan"],
        "ordering": row["ordering"],
        "enabled": row["enabled"],
    }


async def _dispatch(conn: asyncpg.Connection, actor: str) -> None:
    """Render the configuration onto every server carrying the role."""
    nodes = await conn.fetch(
        "SELECT DISTINCT node_fqdn FROM server_role"
        " WHERE role_name = 'radius' AND state <> 'removed'"
    )
    if not nodes:
        return
    clients = [dict(row) for row in await conn.fetch("SELECT * FROM radius_client")]
    policies = [
        dict(row) for row in await conn.fetch("SELECT * FROM radius_policy ORDER BY ordering, name")
    ]
    for node in nodes:
        await tasks.enqueue(
            conn,
            node_fqdn=node["node_fqdn"],
            kind="radius-apply",
            payload=radius.as_task(
                [client for client in clients if client["node_fqdn"] == node["node_fqdn"]],
                policies,
            ),
            subject=node["node_fqdn"],
            requested_by=actor,
        )


@router.get("", dependencies=[Depends(requires("radius.read"))])
async def overview(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    clients = await pool.fetch("SELECT * FROM radius_client ORDER BY node_fqdn, name")
    policies = await pool.fetch("SELECT * FROM radius_policy ORDER BY ordering, name")
    return {
        "clients": [_client_json(row) for row in clients],
        "policies": [_policy_json(row) for row in policies],
    }


@router.post("/clients", status_code=201, dependencies=[Depends(requires("radius.write"))])
async def create_client(
    body: ClientIn,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Add a device that may ask, and return its secret once."""
    name = radius.validate_name(body.name)
    address = radius.validate_address(body.address)
    secret = radius.validate_secret(body.secret) if body.secret else radius.generate_secret()

    async with pool.acquire() as conn:
        if await conn.fetchval(
            "SELECT 1 FROM radius_client"
            " WHERE lower(node_fqdn) = lower($1) AND lower(name) = lower($2)",
            body.node_fqdn,
            name,
        ):
            raise objects.ObjectError(f"{body.node_fqdn} already has a device called {name}")
        row = await conn.fetchrow(
            """
            INSERT INTO radius_client
                (node_fqdn, name, description, address, secret, nas_identifier, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            body.node_fqdn,
            name,
            body.description,
            address,
            secret,
            radius.validate_nas_identifier(body.nas_identifier),
            session.principal,
        )
        await _dispatch(conn, session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="radius.client.create",
            outcome="success",
            object_type="radius_client",
            object_dn=f"{name}@{body.node_fqdn}",
            after={"address": address, "nas_identifier": body.nas_identifier},
        )
    # The only time it is returned: the device needs it, and nothing else does.
    return {**_client_json(row), "secret": secret}


@router.delete("/clients", status_code=204, dependencies=[Depends(requires("radius.write"))])
async def delete_client(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM radius_client WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such device")
        await conn.execute("DELETE FROM radius_client WHERE id = $1::uuid", id)
        await _dispatch(conn, session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="radius.client.delete",
            outcome="success",
            object_type="radius_client",
            object_dn=f"{row['name']}@{row['node_fqdn']}",
            before=_client_json(row),
        )


@router.post("/policies", status_code=201, dependencies=[Depends(requires("radius.write"))])
async def create_policy(
    body: PolicyIn,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    name = radius.validate_name(body.name)
    identifiers = [radius.validate_nas_identifier(entry) for entry in body.nas_identifiers]

    async with pool.acquire() as conn:
        if await conn.fetchval("SELECT 1 FROM radius_policy WHERE lower(name) = lower($1)", name):
            raise objects.ObjectError(f"a rule called {name} already exists")
        row = await conn.fetchrow(
            """
            INSERT INTO radius_policy
                (name, description, group_dn, group_name, principal_kind,
                 nas_identifiers, access, vlan, ordering, enabled, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
            """,
            name,
            body.description,
            body.group_dn,
            body.group_name,
            body.principal_kind,
            identifiers,
            body.access,
            body.vlan,
            body.ordering,
            body.enabled,
            session.principal,
        )
        await _dispatch(conn, session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="radius.policy.create",
            outcome="success",
            object_type="radius_policy",
            object_dn=name,
            after=_policy_json(row),
        )
    return _policy_json(row)


@router.delete("/policies", status_code=204, dependencies=[Depends(requires("radius.write"))])
async def delete_policy(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM radius_policy WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such rule")
        await conn.execute("DELETE FROM radius_policy WHERE id = $1::uuid", id)
        await _dispatch(conn, session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="radius.policy.delete",
            outcome="success",
            object_type="radius_policy",
            object_dn=row["name"],
            before=_policy_json(row),
        )


@router.get("/preview", dependencies=[Depends(requires("radius.read"))])
async def preview(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """The rules as FreeRADIUS will read them.

    Shown because an access decision an operator cannot inspect is one they
    have to guess at. Secrets are not part of this.
    """
    policies = [
        dict(row) for row in await pool.fetch("SELECT * FROM radius_policy ORDER BY ordering, name")
    ]
    return {"policies": radius.render_policies(policies)}
