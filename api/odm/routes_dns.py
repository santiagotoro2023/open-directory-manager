"""DNS zones and records, backed directly by Samba's integrated DNS."""

from __future__ import annotations

from typing import Annotated, Any, Literal

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import dns
from .config import Settings, get_settings
from .routes_directory import _audit_context
from .security import get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/dns", tags=["dns"])

ZoneName = Annotated[str, Field(min_length=1, max_length=253)]
RecordName = Annotated[str, Field(min_length=1, max_length=253)]
RecordData = Annotated[str, Field(min_length=1, max_length=512)]
RecordType = Literal["A", "AAAA", "CNAME", "MX", "NS", "PTR", "SRV", "TXT"]


class ZoneRequest(BaseModel):
    zone: ZoneName


class ReverseZoneRequest(BaseModel):
    """A reverse zone is named after the network it answers for, so ODM works
    the name out rather than making an operator reverse the octets by hand."""

    network: Annotated[str, Field(min_length=7, max_length=64)]


class RecordRequest(BaseModel):
    zone: ZoneName
    name: RecordName
    type: RecordType
    data: RecordData
    # Windows offers this on the record itself, and it is the step most often
    # forgotten: a host with no pointer record fails reverse lookups.
    create_pointer: bool = False


class UpdateRecordRequest(BaseModel):
    zone: ZoneName
    name: RecordName
    type: RecordType
    old_data: RecordData
    new_data: RecordData


@router.get("/status", dependencies=[Depends(requires("dns.read"))])
async def status(
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    return {"available": dns.available(), "server": dns.server(settings)}


@router.get("/zones", dependencies=[Depends(requires("dns.read"))])
async def list_zones(
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    return {"zones": await run_in_threadpool(dns.list_zones, settings)}


@router.get("/zone", dependencies=[Depends(requires("dns.read"))])
async def zone_info(
    zone: Annotated[str, Query(max_length=253)],
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    info = await run_in_threadpool(dns.zone_info, settings, zone)
    records = await run_in_threadpool(dns.list_records, settings, zone)
    return {"zone": info, "records": [record.as_json() for record in records]}


@router.post("/zones", status_code=201, dependencies=[Depends(requires("dns.write"))])
async def create_zone(
    body: ZoneRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with _audit_context(
        request, session, pool, "dns.zone.create", object_type="dns_zone", object_dn=body.zone
    ) as entry:
        await run_in_threadpool(dns.create_zone, settings, body.zone)
        entry.after = {"zone": body.zone}
        return {"zone": body.zone}


@router.post("/zones/reverse", status_code=201, dependencies=[Depends(requires("dns.write"))])
async def create_reverse_zone(
    body: ReverseZoneRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Create the reverse lookup zone for a network."""
    zone = dns.reverse_zone_name(body.network)
    async with _audit_context(
        request, session, pool, "dns.zone.create", object_type="dns_zone", object_dn=zone
    ) as entry:
        await run_in_threadpool(dns.create_zone, settings, zone)
        entry.after = {"zone": zone, "network": body.network}
        return {"zone": zone, "network": body.network}


@router.delete("/zone", status_code=204, dependencies=[Depends(requires("dns.write"))])
async def delete_zone(
    request: Request,
    zone: Annotated[str, Query(max_length=253)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
):
    async with _audit_context(
        request, session, pool, "dns.zone.delete", object_type="dns_zone", object_dn=zone
    ) as entry:
        records = await run_in_threadpool(dns.list_records, settings, zone)
        entry.before = {"records": [record.as_json() for record in records]}
        await run_in_threadpool(dns.delete_zone, settings, zone)


@router.post("/records", status_code=201, dependencies=[Depends(requires("dns.write"))])
async def add_record(
    body: RecordRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with _audit_context(
        request,
        session,
        pool,
        "dns.record.create",
        object_type="dns_record",
        object_dn=f"{body.name}.{body.zone}",
    ) as entry:
        await run_in_threadpool(
            dns.add_record, settings, body.zone, body.name, body.type, body.data
        )
        pointer = None
        if body.create_pointer and body.type == "A":
            pointer = await _add_pointer(settings, body.zone, body.name, body.data)
        entry.after = {"type": body.type, "data": body.data, "pointer": pointer}
        return {
            "name": body.name,
            "zone": body.zone,
            "type": body.type,
            "data": body.data,
            "pointer": pointer,
        }


async def _add_pointer(
    settings: Settings, zone: str, name: str, address: str
) -> str | None:
    """Add the matching pointer record, when a reverse zone covers the address.

    No reverse zone is not a failure: the forward record stands on its own, and
    saying so is more useful than refusing the whole request.
    """
    zones = await run_in_threadpool(dns.list_zones, settings)
    placement = dns.pointer_for(address, [str(entry["name"]) for entry in zones])
    if placement is None:
        return None
    reverse_zone, relative = placement
    host = f"{name}.{zone}." if name not in ("@", "") else f"{zone}."
    await run_in_threadpool(dns.add_record, settings, reverse_zone, relative, "PTR", host)
    return f"{relative}.{reverse_zone}"


@router.patch("/record", dependencies=[Depends(requires("dns.write"))])
async def update_record(
    body: UpdateRecordRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with _audit_context(
        request,
        session,
        pool,
        "dns.record.update",
        object_type="dns_record",
        object_dn=f"{body.name}.{body.zone}",
    ) as entry:
        await run_in_threadpool(
            dns.update_record, settings, body.zone, body.name, body.type, body.old_data,
            body.new_data,
        )
        entry.before = {"type": body.type, "data": body.old_data}
        entry.after = {"type": body.type, "data": body.new_data}
        return {"name": body.name, "zone": body.zone, "type": body.type, "data": body.new_data}


@router.delete("/record", status_code=204, dependencies=[Depends(requires("dns.write"))])
async def delete_record(
    request: Request,
    zone: Annotated[str, Query(max_length=253)],
    name: Annotated[str, Query(max_length=253)],
    type: RecordType = Query(),
    data: Annotated[str, Query(max_length=512)] = "",
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
):
    async with _audit_context(
        request,
        session,
        pool,
        "dns.record.delete",
        object_type="dns_record",
        object_dn=f"{name}.{zone}",
    ) as entry:
        entry.before = {"type": type, "data": data}
        await run_in_threadpool(dns.delete_record, settings, zone, name, type, data)
