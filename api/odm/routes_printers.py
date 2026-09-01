"""Printers: what exists, on which server, and how it reaches clients."""

from __future__ import annotations

import json
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from . import audit, objects, printers, tasks
from .security import client_ip, get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/printers", tags=["printers"])


class PrinterIn(BaseModel):
    node_fqdn: Annotated[str, Field(min_length=1, max_length=253)]
    name: Annotated[str, Field(min_length=1, max_length=63)]
    device_uri: Annotated[str, Field(min_length=6, max_length=255)]
    description: Annotated[str, Field(max_length=255)] = ""
    location: Annotated[str, Field(max_length=255)] = ""
    # The PPD itself, pasted or uploaded. Empty means driverless IPP.
    ppd: Annotated[str, Field(max_length=4_000_000)] | None = None
    ppd_name: Annotated[str, Field(max_length=128)] = ""
    duplex: bool = False
    colour: bool = True
    shared: bool = True


class PrinterUpdate(BaseModel):
    id: Annotated[str, Field(min_length=36, max_length=36)]
    device_uri: Annotated[str, Field(max_length=255)] | None = None
    description: Annotated[str, Field(max_length=255)] | None = None
    location: Annotated[str, Field(max_length=255)] | None = None
    ppd: Annotated[str, Field(max_length=4_000_000)] | None = None
    ppd_name: Annotated[str, Field(max_length=128)] | None = None
    duplex: bool | None = None
    colour: bool | None = None
    shared: bool | None = None


def _json(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "node_fqdn": row["node_fqdn"],
        "name": row["name"],
        "description": row["description"],
        "location": row["location"],
        "device_uri": row["device_uri"],
        # The PPD can be megabytes; the console only needs to know there is one.
        "has_ppd": bool(row["ppd"]),
        "ppd_name": row["ppd_name"],
        "duplex": row["duplex"],
        "colour": row["colour"],
        "shared": row["shared"],
        "state": row["state"],
        "last_error": row["last_error"],
        "uri": f"ipp://{row['node_fqdn']}/printers/{row['name']}",
        "updated_at": row["updated_at"],
    }


async def _dispatch(conn: asyncpg.Connection, row: asyncpg.Record, actor: str) -> None:
    await conn.execute("UPDATE printer SET state = 'applying' WHERE id = $1", row["id"])
    await tasks.enqueue(
        conn,
        node_fqdn=row["node_fqdn"],
        kind="printer-apply",
        payload=printers.as_task(dict(row)),
        subject=str(row["id"]),
        requested_by=actor,
    )


@router.get("/devices", dependencies=[Depends(requires("printer.read"))])
async def discovered_devices(
    node_fqdn: Annotated[str, Query(min_length=1, max_length=253)],
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """What that print server can currently print to.

    Reported by the server with the rest of its inventory, so this is instant
    rather than a request that waits for the next check-in. Empty means the
    machine has not reported since the print-server role went on, or found
    nothing.
    """
    row = await pool.fetchrow(
        "SELECT print_devices FROM computer_fact WHERE lower(hostname) = lower($1)",
        node_fqdn,
    )
    devices = json.loads(row["print_devices"]) if row and row["print_devices"] else []
    return {"devices": devices}


@router.get("", dependencies=[Depends(requires("printer.read"))])
async def list_printers(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    rows = await pool.fetch("SELECT * FROM printer ORDER BY node_fqdn, name")
    return {"printers": [_json(row) for row in rows]}


@router.get("/discover", dependencies=[Depends(requires("printer.read"))])
async def discover(
    node: Annotated[str, Query(min_length=1, max_length=253)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Ask a print server what printers it can see, now.

    The same list rides the machine's check-in, so choosing one is normally
    instant — but a server installed a minute ago has not checked in yet, and
    a printer plugged in since then is not on that list either.
    """
    row = await pool.fetchrow(
        "SELECT hostname FROM computer_fact WHERE lower(hostname) = lower($1)", node
    )
    if row is None:
        raise objects.NotFound(f"{node} has not reported to the console yet")
    try:
        answer = await tasks.run_now(
            pool,
            node_fqdn=row["hostname"],
            kind="printer-discover",
            payload={},
            requested_by=session.principal,
            timeout=45.0,
        )
    except tasks.TaskFailed as exc:
        raise objects.ObjectError(str(exc)) from exc
    try:
        return json.loads(answer)
    except ValueError as exc:
        raise objects.ObjectError(f"{node} sent something unreadable back") from exc


@router.post("", status_code=201, dependencies=[Depends(requires("printer.write"))])
async def create_printer(
    body: PrinterIn,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    name = printers.validate_name(body.name)
    device_uri = printers.validate_device_uri(body.device_uri)
    ppd = printers.validate_ppd(body.ppd)

    async with pool.acquire() as conn:
        if await conn.fetchval(
            "SELECT 1 FROM printer WHERE lower(node_fqdn) = lower($1) AND lower(name) = lower($2)",
            body.node_fqdn,
            name,
        ):
            raise objects.ObjectError(f"{body.node_fqdn} already has a printer called {name}")
        row = await conn.fetchrow(
            """
            INSERT INTO printer (node_fqdn, name, description, location, device_uri,
                                 ppd, ppd_name, duplex, colour, shared, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
            """,
            body.node_fqdn,
            name,
            body.description,
            body.location,
            device_uri,
            ppd,
            body.ppd_name,
            body.duplex,
            body.colour,
            body.shared,
            session.principal,
        )
        await _dispatch(conn, row, session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="printer.create",
            outcome="success",
            object_type="printer",
            object_dn=f"{name}@{body.node_fqdn}",
            after=_json(row),
        )
    return _json(row)


@router.patch("", dependencies=[Depends(requires("printer.write"))])
async def update_printer(
    body: PrinterUpdate,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        before = await conn.fetchrow("SELECT * FROM printer WHERE id = $1::uuid", body.id)
        if before is None:
            raise objects.NotFound("no such printer")
        row = await conn.fetchrow(
            """
            UPDATE printer SET
                device_uri  = COALESCE($2, device_uri),
                description = COALESCE($3, description),
                location    = COALESCE($4, location),
                ppd         = COALESCE($5, ppd),
                ppd_name    = COALESCE($6, ppd_name),
                duplex      = COALESCE($7, duplex),
                colour      = COALESCE($8, colour),
                shared      = COALESCE($9, shared),
                updated_at  = now()
            WHERE id = $1::uuid
            RETURNING *
            """,
            body.id,
            printers.validate_device_uri(body.device_uri) if body.device_uri else None,
            body.description,
            body.location,
            printers.validate_ppd(body.ppd),
            body.ppd_name,
            body.duplex,
            body.colour,
            body.shared,
        )
        await _dispatch(conn, row, session.principal)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="printer.update",
            outcome="success",
            object_type="printer",
            object_dn=f"{row['name']}@{row['node_fqdn']}",
            before=_json(before),
            after=_json(row),
        )
    return _json(row)


@router.delete("", status_code=204, dependencies=[Depends(requires("printer.write"))])
async def delete_printer(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    """Remove the queue from the print server.

    Policy objects that hand this printer out are not touched: they name it,
    and an operator removing a printer may well be replacing it.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM printer WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such printer")
        await tasks.enqueue(
            conn,
            node_fqdn=row["node_fqdn"],
            kind="printer-remove",
            payload={"name": row["name"]},
            subject=str(row["id"]),
            requested_by=session.principal,
        )
        await conn.execute("DELETE FROM printer WHERE id = $1::uuid", id)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="printer.delete",
            outcome="success",
            object_type="printer",
            object_dn=f"{row['name']}@{row['node_fqdn']}",
            before=_json(row),
        )
