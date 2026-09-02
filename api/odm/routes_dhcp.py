"""DHCP scopes, reservations, leases and failover status via ISC Kea."""

from __future__ import annotations

import socket
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import kea
from .config import Settings, get_settings
from .routes_directory import _audit_context
from .security import get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/dhcp", tags=["dhcp"])


class Pool(BaseModel):
    pool: Annotated[str, Field(min_length=7, max_length=96)]


class Option(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]
    data: Annotated[str, Field(max_length=512)] = ""


class Scope(BaseModel):
    subnet: Annotated[str, Field(min_length=9, max_length=64)]
    pools: Annotated[list[Pool], Field(default_factory=list, max_length=32)]
    option_data: Annotated[list[Option], Field(default_factory=list, max_length=64)]
    valid_lifetime: Annotated[int | None, Field(default=None, ge=60, le=2_592_000)] = None
    renew_timer: Annotated[int | None, Field(default=None, ge=30, le=2_592_000)] = None
    rebind_timer: Annotated[int | None, Field(default=None, ge=30, le=2_592_000)] = None
    comment: Annotated[str, Field(default="", max_length=256)] = ""

    def to_kea(self) -> dict[str, Any]:
        return {
            "subnet": self.subnet,
            "pools": [pool.model_dump() for pool in self.pools],
            "option-data": [option.model_dump() for option in self.option_data],
            "valid-lifetime": self.valid_lifetime,
            "renew-timer": self.renew_timer,
            "rebind-timer": self.rebind_timer,
            "comment": self.comment,
        }


class UpdateScope(Scope):
    id: Annotated[int, Field(ge=1)]


class Reservation(BaseModel):
    subnet_id: Annotated[int, Field(ge=1)]
    hw_address: Annotated[str, Field(min_length=17, max_length=17)]
    ip_address: Annotated[str, Field(min_length=7, max_length=45)]
    hostname: Annotated[str, Field(default="", max_length=64)] = ""

    def to_kea(self) -> dict[str, Any]:
        return {
            "hw-address": self.hw_address,
            "ip-address": self.ip_address,
            "hostname": self.hostname,
        }


@router.get("/status", dependencies=[Depends(requires("dhcp.read"))])
async def status(
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Whether the DHCP role is installed, and the failover state if it is."""
    if not kea.configured(settings):
        return {"configured": False}
    return {
        "configured": True,
        "high_availability": await run_in_threadpool(kea.ha_status, settings),
        "statistics": await run_in_threadpool(kea.statistics, settings),
    }


def _domain_addresses(domain: str) -> list[str]:
    """The addresses the domain itself answers on — its domain controllers.

    Every DC registers an A record for the domain name, which is how a client
    finds one in the first place, so this is the same list a joined machine
    resolves.
    """
    try:
        infos = socket.getaddrinfo(domain, None, socket.AF_INET, socket.SOCK_DGRAM)
    except OSError:
        return []
    return sorted({str(info[4][0]) for info in infos})


@router.get("/defaults", dependencies=[Depends(requires("dhcp.read"))])
async def scope_defaults(
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """What a new scope should hand out unless the operator says otherwise.

    A scope that hands out no DNS server is the single most common way a
    working domain looks broken: the client gets an address, and then nothing
    it is told to reach by name resolves — a share included, where the file
    manager reports "Invalid argument" rather than anything about DNS.
    """
    return {
        "domain_name": settings.domain,
        "dns_servers": await run_in_threadpool(_domain_addresses, settings.domain),
    }


@router.get("/scopes", dependencies=[Depends(requires("dhcp.read"))])
async def list_scopes(
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    return {"scopes": await run_in_threadpool(kea.subnets, settings)}


@router.post("/scopes", status_code=201, dependencies=[Depends(requires("dhcp.write"))])
async def create_scope(
    body: Scope,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with _audit_context(
        request, session, pool, "dhcp.scope.create", object_type="dhcp_scope",
        object_dn=body.subnet,
    ) as entry:
        created = await run_in_threadpool(kea.create_scope, settings, body.to_kea())
        entry.after = created
        return created


@router.patch("/scope", dependencies=[Depends(requires("dhcp.write"))])
async def update_scope(
    body: UpdateScope,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with _audit_context(
        request, session, pool, "dhcp.scope.update", object_type="dhcp_scope",
        object_dn=body.subnet,
    ) as entry:
        scopes = await run_in_threadpool(kea.subnets, settings)
        entry.before = next((s for s in scopes if int(s.get("id", 0)) == body.id), None)
        updated = await run_in_threadpool(kea.update_scope, settings, body.id, body.to_kea())
        entry.after = updated
        return updated


@router.delete("/scope", status_code=204, dependencies=[Depends(requires("dhcp.write"))])
async def delete_scope(
    request: Request,
    id: Annotated[int, Query(ge=1)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
):
    async with _audit_context(
        request, session, pool, "dhcp.scope.delete", object_type="dhcp_scope", object_dn=str(id)
    ) as entry:
        removed = await run_in_threadpool(kea.delete_scope, settings, id)
        entry.before = removed


@router.post("/reservations", status_code=201, dependencies=[Depends(requires("dhcp.write"))])
async def add_reservation(
    body: Reservation,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with _audit_context(
        request, session, pool, "dhcp.reservation.create", object_type="dhcp_reservation",
        object_dn=body.hw_address,
    ) as entry:
        created = await run_in_threadpool(
            kea.add_reservation, settings, body.subnet_id, body.to_kea()
        )
        entry.after = created
        return created


@router.delete("/reservation", status_code=204, dependencies=[Depends(requires("dhcp.write"))])
async def delete_reservation(
    request: Request,
    subnet_id: Annotated[int, Query(ge=1)],
    hw_address: Annotated[str, Query(min_length=17, max_length=17)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
):
    async with _audit_context(
        request, session, pool, "dhcp.reservation.delete", object_type="dhcp_reservation",
        object_dn=hw_address,
    ) as entry:
        entry.before = {"subnet_id": subnet_id, "hw_address": hw_address}
        await run_in_threadpool(kea.delete_reservation, settings, subnet_id, hw_address)


@router.get("/leases", dependencies=[Depends(requires("dhcp.read"))])
async def list_leases(
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Current leases. DHCP-assigned hosts also appear in DNS via kea-dhcp-ddns."""
    return {"leases": await run_in_threadpool(kea.leases, settings)}
