"""Remote access: tunnels, the peers on them, and the configurations handed out."""

from __future__ import annotations

from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field

from . import audit, objects, tasks, vpn
from .security import client_ip, get_pool, require_admin, requires, requires_domain_admin
from .sessions import Session

router = APIRouter(prefix="/api/v1/vpn", tags=["vpn"])


class TunnelIn(BaseModel):
    node_fqdn: Annotated[str, Field(min_length=1, max_length=253)]
    name: Annotated[str, Field(min_length=1, max_length=31)]
    description: Annotated[str, Field(max_length=255)] = ""
    endpoint: Annotated[str, Field(min_length=1, max_length=253)]
    listen_port: Annotated[int, Field(ge=1, le=65535)] = 51820
    network: Annotated[str, Field(min_length=9, max_length=64)]
    routes: list[Annotated[str, Field(max_length=64)]] = Field(default_factory=list)
    dns_servers: list[Annotated[str, Field(max_length=64)]] = Field(default_factory=list)
    search_domain: Annotated[str, Field(max_length=253)] = ""


class TunnelUpdate(BaseModel):
    id: Annotated[str, Field(min_length=36, max_length=36)]
    description: Annotated[str, Field(max_length=255)] | None = None
    endpoint: Annotated[str, Field(max_length=253)] | None = None
    listen_port: Annotated[int, Field(ge=1, le=65535)] | None = None
    routes: list[Annotated[str, Field(max_length=64)]] | None = None
    dns_servers: list[Annotated[str, Field(max_length=64)]] | None = None
    search_domain: Annotated[str, Field(max_length=253)] | None = None


class PeerIn(BaseModel):
    tunnel_id: Annotated[str, Field(min_length=36, max_length=36)]
    name: Annotated[str, Field(min_length=1, max_length=63)]
    # The computer or user this peer belongs to, when it is a domain object.
    principal_dn: Annotated[str, Field(max_length=1024)] | None = None
    always_on: bool = False


def _tunnel_json(row: asyncpg.Record, peers: int = 0) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "node_fqdn": row["node_fqdn"],
        "name": row["name"],
        "description": row["description"],
        "endpoint": row["endpoint"],
        "listen_port": row["listen_port"],
        "network": row["network"],
        "routes": list(row["routes"]),
        "dns_servers": list(row["dns_servers"]),
        "search_domain": row["search_domain"],
        # The public half only: the private key never leaves the control plane
        # except to the node that terminates the tunnel.
        "public_key": row["public_key"],
        "state": row["state"],
        "last_error": row["last_error"],
        "peers": peers,
        "updated_at": row["updated_at"],
    }


def _peer_json(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "tunnel_id": str(row["tunnel_id"]),
        "name": row["name"],
        "principal_dn": row["principal_dn"],
        "address": row["address"],
        "public_key": row["public_key"],
        "always_on": row["always_on"],
        "enabled": row["enabled"],
        # Whether a configuration can still be handed out for this peer.
        "exportable": bool(row["private_key"]),
        "created_at": row["created_at"],
    }


async def _dispatch(conn: asyncpg.Connection, tunnel_id: str, actor: str) -> None:
    """Queue the node to bring the tunnel up with its current peer list."""
    tunnel = await conn.fetchrow("SELECT * FROM vpn_tunnel WHERE id = $1::uuid", tunnel_id)
    if tunnel is None:
        raise objects.NotFound("no such tunnel")
    peers = await conn.fetch(
        "SELECT * FROM vpn_peer WHERE tunnel_id = $1::uuid ORDER BY name", tunnel_id
    )
    await conn.execute("UPDATE vpn_tunnel SET state = 'applying' WHERE id = $1::uuid", tunnel_id)
    await tasks.enqueue(
        conn,
        node_fqdn=tunnel["node_fqdn"],
        kind="vpn-apply",
        payload=vpn.as_task(dict(tunnel), [dict(peer) for peer in peers]),
        subject=str(tunnel["id"]),
        requested_by=actor,
    )


@router.get("", dependencies=[Depends(requires("vpn.read"))])
async def list_tunnels(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT t.*, (SELECT count(*) FROM vpn_peer p WHERE p.tunnel_id = t.id) AS peer_count
        FROM vpn_tunnel t ORDER BY t.name
        """
    )
    return {"tunnels": [_tunnel_json(row, int(row["peer_count"])) for row in rows]}


@router.post("", status_code=201, dependencies=[Depends(requires("vpn.write"))])
async def create_tunnel(
    body: TunnelIn,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    name = vpn.validate_name(body.name)
    network = vpn.validate_network(body.network)
    private_key, public_key = vpn.keypair()

    async with pool.acquire() as conn:
        if await conn.fetchval("SELECT 1 FROM vpn_tunnel WHERE lower(name) = lower($1)", name):
            raise objects.ObjectError(f"a tunnel called {name} already exists")
        row = await conn.fetchrow(
            """
            INSERT INTO vpn_tunnel (node_fqdn, name, description, endpoint, listen_port,
                                    network, routes, dns_servers, search_domain,
                                    private_key, public_key, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *
            """,
            body.node_fqdn,
            name,
            body.description,
            vpn.validate_endpoint(body.endpoint),
            body.listen_port,
            network,
            vpn.validate_routes(body.routes),
            vpn.validate_addresses(body.dns_servers),
            body.search_domain,
            private_key,
            public_key,
            session.principal,
        )
        await _dispatch(conn, str(row["id"]), session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="vpn.tunnel.create",
            outcome="success",
            object_type="vpn_tunnel",
            object_dn=name,
            after=_tunnel_json(row),
        )
    return _tunnel_json(row)


@router.patch("", dependencies=[Depends(requires("vpn.write"))])
async def update_tunnel(
    body: TunnelUpdate,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        before = await conn.fetchrow("SELECT * FROM vpn_tunnel WHERE id = $1::uuid", body.id)
        if before is None:
            raise objects.NotFound("no such tunnel")
        row = await conn.fetchrow(
            """
            UPDATE vpn_tunnel SET
                description   = COALESCE($2, description),
                endpoint      = COALESCE($3, endpoint),
                listen_port   = COALESCE($4, listen_port),
                routes        = COALESCE($5, routes),
                dns_servers   = COALESCE($6, dns_servers),
                search_domain = COALESCE($7, search_domain),
                updated_at    = now()
            WHERE id = $1::uuid
            RETURNING *
            """,
            body.id,
            body.description,
            vpn.validate_endpoint(body.endpoint) if body.endpoint else None,
            body.listen_port,
            vpn.validate_routes(body.routes) if body.routes is not None else None,
            vpn.validate_addresses(body.dns_servers) if body.dns_servers is not None else None,
            body.search_domain,
        )
        await _dispatch(conn, body.id, session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="vpn.tunnel.update",
            outcome="success",
            object_type="vpn_tunnel",
            object_dn=row["name"],
            before=_tunnel_json(before),
            after=_tunnel_json(row),
        )
    return _tunnel_json(row)


@router.delete("", status_code=204, dependencies=[Depends(requires_domain_admin())])
async def delete_tunnel(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    """Remove the tunnel and every peer on it.

    Configurations already handed out stop working, which is the point.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM vpn_tunnel WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such tunnel")
        await tasks.enqueue(
            conn,
            node_fqdn=row["node_fqdn"],
            kind="vpn-apply",
            payload={"name": row["name"], "remove": True},
            subject=str(row["id"]),
            requested_by=session.principal,
        )
        await conn.execute("DELETE FROM vpn_tunnel WHERE id = $1::uuid", id)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="vpn.tunnel.delete",
            outcome="success",
            object_type="vpn_tunnel",
            object_dn=row["name"],
            before=_tunnel_json(row),
        )


# ------------------------------------------------------------------- peers ---


@router.get("/peers", dependencies=[Depends(requires("vpn.read"))])
async def list_peers(
    tunnel_id: Annotated[str, Query(min_length=36, max_length=36)],
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    rows = await pool.fetch(
        "SELECT * FROM vpn_peer WHERE tunnel_id = $1::uuid ORDER BY name", tunnel_id
    )
    return {"peers": [_peer_json(row) for row in rows]}


@router.post("/peers", status_code=201, dependencies=[Depends(requires("vpn.write"))])
async def create_peer(
    body: PeerIn,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Add a peer and give it the next free address on the tunnel."""
    async with pool.acquire() as conn:
        tunnel = await conn.fetchrow(
            "SELECT * FROM vpn_tunnel WHERE id = $1::uuid", body.tunnel_id
        )
        if tunnel is None:
            raise objects.NotFound("no such tunnel")
        taken = [
            row["address"]
            for row in await conn.fetch(
                "SELECT address FROM vpn_peer WHERE tunnel_id = $1::uuid", body.tunnel_id
            )
        ]
        address = vpn.next_peer_address(tunnel["network"], taken)
        private_key, public_key = vpn.keypair()

        row = await conn.fetchrow(
            """
            INSERT INTO vpn_peer (tunnel_id, name, principal_dn, address,
                                  private_key, public_key, always_on, created_by)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
            """,
            body.tunnel_id,
            vpn.validate_name(body.name) if len(body.name) <= 31 else body.name[:31],
            body.principal_dn,
            address,
            private_key,
            public_key,
            body.always_on,
            session.principal,
        )
        await _dispatch(conn, body.tunnel_id, session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="vpn.peer.create",
            outcome="success",
            object_type="vpn_peer",
            object_dn=f"{row['name']}@{tunnel['name']}",
            after={"address": address, "always_on": body.always_on},
        )
    return _peer_json(row)


@router.delete("/peers", status_code=204, dependencies=[Depends(requires("vpn.write"))])
async def delete_peer(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM vpn_peer WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such peer")
        await conn.execute("DELETE FROM vpn_peer WHERE id = $1::uuid", id)
        await _dispatch(conn, str(row["tunnel_id"]), session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="vpn.peer.delete",
            outcome="success",
            object_type="vpn_peer",
            object_dn=row["name"],
            before=_peer_json(row),
        )


@router.get("/peers/configuration", dependencies=[Depends(requires("vpn.write"))])
async def peer_configuration(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> Response:
    """The configuration file this peer connects with.

    Gated on vpn.write, not vpn.read: it contains a private key, so handing it
    out is closer to creating access than to looking at it. Every export is
    audited for the same reason.
    """
    async with pool.acquire() as conn:
        peer = await conn.fetchrow("SELECT * FROM vpn_peer WHERE id = $1::uuid", id)
        if peer is None:
            raise objects.NotFound("no such peer")
        tunnel = await conn.fetchrow(
            "SELECT * FROM vpn_tunnel WHERE id = $1", peer["tunnel_id"]
        )
        body = vpn.client_config(dict(tunnel), dict(peer))
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="vpn.peer.export",
            outcome="success",
            object_type="vpn_peer",
            object_dn=f"{peer['name']}@{tunnel['name']}",
            detail="the peer's configuration, including its private key, was downloaded",
        )
    return Response(
        content=body,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{tunnel["name"]}-{peer["name"]}.conf"'
        },
    )
