"""Domain controllers: which machines hold the directory, and how they are doing.

A read-only controller is not a setting on an existing one. Samba decides it
when a controller *joins* the domain, the same way Windows does, and there is
no supported path from writable to read-only or back. So this reports what each
controller is, and produces the command that adds a new one — rather than a
toggle that could not do what it says.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Annotated, Any, Literal

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import agents, audit, directory, objects, replication, sites
from .config import Settings, get_settings
from .routes_directory import _read
from .security import client_ip, get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/controllers", tags=["controllers"])

# userAccountControl bits on a controller's computer account.
SERVER_TRUST_ACCOUNT = 8192
PARTIAL_SECRETS_ACCOUNT = 0x04000000  # set on a read-only controller


def _controllers(conn, settings: Settings) -> list[dict[str, Any]]:
    found, _ = objects.search(
        conn,
        settings,
        object_type="computer",
        container=None,
        query=None,
        scope="subtree",
        limit=200,
    )
    controllers = []
    for entry in found:
        uac = int(entry.get("userAccountControl") or 0)
        if not uac & (SERVER_TRUST_ACCOUNT | PARTIAL_SECRETS_ACCOUNT):
            continue
        controllers.append(
            {
                "name": str(entry.get("cn") or ""),
                "fqdn": str(entry.get("dNSHostName") or ""),
                "distinguished_name": entry["distinguishedName"],
                "operating_system": str(entry.get("operatingSystem") or ""),
                # A read-only controller holds no secrets for the accounts it
                # serves, which is the whole point of putting one in a branch.
                "read_only": bool(uac & PARTIAL_SECRETS_ACCOUNT),
            }
        )
    return controllers


@router.get("", dependencies=[Depends(requires("dc.read"))])
async def list_controllers(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    controllers = await _read(settings, _controllers)

    contact = await agents.last_contact(pool)
    status = await _replication(pool, settings, controllers)

    return {
        "controllers": [
            {
                **controller,
                **agents.describe(contact.get(controller["distinguished_name"].lower())),
            }
            for controller in controllers
        ],
        "replication": status,
        "writable": sum(1 for entry in controllers if not entry["read_only"]),
        "read_only": sum(1 for entry in controllers if entry["read_only"]),
    }


async def _replication(
    pool: asyncpg.Pool, settings: Settings, controllers: list[dict[str, Any]]
) -> dict[str, Any]:
    """Replication as the controllers themselves report it.

    Each controller collects its own state with its inventory, because Samba
    will not answer the call to anything below domain-controller level
    (replication.py says which check and why). Running it here is the fallback
    for a control plane that does hold that level, and a controller that will
    not answer must not stop the page rendering.
    """
    reported = await pool.fetch(
        """
        SELECT computer_dn, hostname, replication, replication_at
        FROM computer_fact WHERE replication IS NOT NULL
        """
    )
    by_dn = {row["computer_dn"].lower(): row for row in reported}

    inbound: list[dict[str, Any]] = []
    collected: datetime | None = None
    sources: list[str] = []
    for controller in controllers:
        row = by_dn.get(controller["distinguished_name"].lower())
        if row is None:
            continue
        parsed = replication.parse(row["replication"], row["hostname"])
        for entry in parsed["inbound"]:
            inbound.append({**entry, "on": row["hostname"]})
        sources.append(row["hostname"])
        if row["replication_at"] and (collected is None or row["replication_at"] > collected):
            collected = row["replication_at"]

    if sources:
        return {
            "inbound": inbound,
            "healthy": all(entry["succeeded"] is not False for entry in inbound),
            "servers": sources,
            "collected_at": collected,
            "source": "agent",
        }

    # Nothing reported yet: try here, and say what the answer was.
    try:
        return {
            **await run_in_threadpool(replication.status, settings),
            "servers": [],
            "source": "control plane",
        }
    except Exception as exc:  # noqa: BLE001 - reported, not raised
        return {"available": False, "detail": str(exc)}


class AgentSchedule(BaseModel):
    """How often every machine asks for policy, and how it hears about changes."""

    # Four intervals rather than a free number: a minute is as often as is
    # useful, half an hour as rare as is safe, and anything between them is a
    # preference rather than a decision.
    poll_minutes: Literal[1, 5, 15, 30] = 15
    push_enabled: bool = False


async def agent_schedule(pool: asyncpg.Pool) -> dict[str, Any]:
    """The domain's agent schedule, with the defaults where none is stored."""
    row = await pool.fetchrow("SELECT poll_minutes, push_enabled FROM agent_schedule")
    if row is None:
        return {"poll_minutes": 15, "push_enabled": False}
    return {"poll_minutes": row["poll_minutes"], "push_enabled": row["push_enabled"]}


@router.get("/agents", dependencies=[Depends(requires("dc.read"))])
async def read_agent_schedule(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    return await agent_schedule(pool)


@router.put("/agents", dependencies=[Depends(requires("dc.write"))])
async def write_agent_schedule(
    body: AgentSchedule,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Set the interval every agent polls on, and whether changes are pushed.

    A machine learns the interval from the policy document it already fetches,
    so it takes effect on the next poll — within half an hour at the longest
    interval — and no machine is left without a working one in the meantime.
    """
    async with pool.acquire() as conn:
        before = await agent_schedule(pool)
        await conn.execute(
            """
            INSERT INTO agent_schedule (id, poll_minutes, push_enabled, updated_by)
            VALUES (true, $1, $2, $3)
            ON CONFLICT (id) DO UPDATE SET
                poll_minutes = EXCLUDED.poll_minutes,
                push_enabled = EXCLUDED.push_enabled,
                updated_at = now(),
                updated_by = EXCLUDED.updated_by
            """,
            body.poll_minutes,
            body.push_enabled,
            session.principal,
        )
        after = await agent_schedule(pool)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="agent.schedule",
            outcome="success",
            object_type="domain",
            object_dn="agents",
            before=before,
            after=after,
        )
    return after


@router.get("/join-command", dependencies=[Depends(requires("dc.read"))])
async def join_command(
    hostname: Annotated[str, Query(max_length=253)] = "",
    read_only: Annotated[bool, Query()] = False,
    site: Annotated[str, Query(max_length=64)] = "Default-First-Site-Name",
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """The command that adds a controller, to run on the machine joining.

    It is produced rather than executed: this runs on a machine that is already
    a controller, and joining has to happen on the one becoming one.
    """
    role = "RODC" if read_only else "DC"
    steps = [
        "sudo apt-get install -y samba samba-ad-dc samba-ad-provision "
        "python3-samba krb5-user winbind libnss-winbind ldb-tools chrony",
        "sudo systemctl disable --now smbd nmbd winbind",
        "sudo mv /etc/samba/smb.conf /etc/samba/smb.conf.pre-join",
        (
            f"sudo samba-tool domain join {settings.domain} {role} "
            f"-U Administrator --dns-backend=SAMBA_INTERNAL "
            f'--site="{site}"'
        ),
        "sudo install -m 0644 /var/lib/samba/private/krb5.conf /etc/krb5.conf",
        "sudo systemctl enable --now samba-ad-dc",
    ]
    return {
        "hostname": hostname,
        "read_only": read_only,
        "role": role,
        "steps": steps,
        "notes": [
            "Run these on the machine becoming a controller, not on this one.",
            "Its resolver must point at an existing controller before joining, "
            "and its clock must be within five minutes of one.",
            "A read-only controller keeps no account secrets, so a branch site "
            "can authenticate without holding credentials that matter elsewhere. "
            "It cannot be converted to a writable one afterwards, or the reverse.",
        ],
    }


@router.get("/replication", dependencies=[Depends(requires("dc.read"))])
async def controller_replication(
    server: Annotated[str, Query(max_length=253)] = "",
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Inbound replication as one controller sees it."""
    return await run_in_threadpool(replication.status, settings, server or None)


@router.get("/health", dependencies=[Depends(requires("dc.read"))])
async def controller_health(
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Whether the directory answers at all, from this host."""
    try:
        conn = await run_in_threadpool(directory.service_connection, settings)
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "detail": str(exc)}
    await run_in_threadpool(conn.unbind)
    return {"available": True}


# ------------------------------------------------------------------ sites ---
# Where machines are, and which controllers are near them.


class SiteIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=63)]
    description: Annotated[str, Field(max_length=255)] = ""


class SubnetIn(BaseModel):
    cidr: Annotated[str, Field(min_length=9, max_length=64)]
    site_name: Annotated[str, Field(min_length=1, max_length=63)]
    description: Annotated[str, Field(max_length=255)] = ""


class AssignmentIn(BaseModel):
    controller_dn: Annotated[str, Field(min_length=3, max_length=1024)]
    site_name: Annotated[str, Field(min_length=1, max_length=63)]
    hostname: Annotated[str, Field(max_length=253)] = ""


@router.get("/sites", dependencies=[Depends(requires("site.read"))])
async def list_sites(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Sites, their subnets, their controllers, and what is in them."""
    site_rows = await pool.fetch("SELECT * FROM ad_site ORDER BY name")
    subnets = await pool.fetch("SELECT * FROM ad_subnet ORDER BY site_name, cidr")
    assigned = await pool.fetch("SELECT * FROM ad_site_controller ORDER BY site_name, hostname")
    machines = await pool.fetch(
        "SELECT site_name, count(*) AS total FROM computer_fact"
        " WHERE site_name IS NOT NULL GROUP BY site_name"
    )
    counts = {row["site_name"]: int(row["total"]) for row in machines}

    return {
        "sites": [
            {
                **sites.as_json(dict(row)),
                "subnets": [
                    {"cidr": s["cidr"], "description": s["description"]}
                    for s in subnets
                    if s["site_name"] == row["name"]
                ],
                "controllers": [
                    {"controller_dn": a["controller_dn"], "hostname": a["hostname"]}
                    for a in assigned
                    if a["site_name"] == row["name"]
                ],
                "machines": counts.get(row["name"], 0),
            }
            for row in site_rows
        ],
        # Machines whose address matches no subnet: they have nowhere to prefer.
        "unplaced": await pool.fetchval(
            "SELECT count(*) FROM computer_fact WHERE site_name IS NULL"
        ),
    }


@router.post("/sites", status_code=201, dependencies=[Depends(requires("site.write"))])
async def create_site(
    body: SiteIn,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    name = sites.validate_name(body.name)
    async with pool.acquire() as conn:
        if await conn.fetchval("SELECT 1 FROM ad_site WHERE lower(name) = lower($1)", name):
            raise objects.ObjectError(f"a site called {name} already exists")
        row = await conn.fetchrow(
            "INSERT INTO ad_site (name, description, created_by) VALUES ($1, $2, $3) RETURNING *",
            name,
            body.description,
            session.principal,
        )
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="site.create",
            outcome="success",
            object_type="site",
            object_dn=name,
        )
    return sites.as_json(dict(row))


@router.delete("/sites", status_code=204, dependencies=[Depends(requires("site.write"))])
async def delete_site(
    request: Request,
    name: Annotated[str, Query(min_length=1, max_length=63)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    """Remove a site, its subnets and its controller assignments.

    Machines placed there become unplaced, which is what they were before.
    """
    async with pool.acquire() as conn:
        if not await conn.fetchval("SELECT 1 FROM ad_site WHERE name = $1", name):
            raise objects.NotFound("no such site")
        await conn.execute("DELETE FROM ad_site WHERE name = $1", name)
        await conn.execute("UPDATE computer_fact SET site_name = NULL WHERE site_name = $1", name)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="site.delete",
            outcome="success",
            object_type="site",
            object_dn=name,
        )


@router.post("/sites/subnets", status_code=201, dependencies=[Depends(requires("site.write"))])
async def add_subnet(
    body: SubnetIn,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    cidr = sites.validate_subnet(body.cidr)
    async with pool.acquire() as conn:
        if not await conn.fetchval("SELECT 1 FROM ad_site WHERE name = $1", body.site_name):
            raise objects.NotFound(f"no site called {body.site_name}")
        existing = [row["cidr"] for row in await conn.fetch("SELECT cidr FROM ad_subnet")]
        await conn.execute(
            """
            INSERT INTO ad_subnet (cidr, site_name, description, created_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (cidr) DO UPDATE
                SET site_name = excluded.site_name, description = excluded.description
            """,
            cidr,
            body.site_name,
            body.description,
            session.principal,
        )
        await _replace_sites(conn)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="site.subnet.add",
            outcome="success",
            object_type="subnet",
            object_dn=cidr,
            after={"site": body.site_name},
        )
    # Overlap is legal and often deliberate; it is reported so nobody is
    # surprised by which one wins.
    return {"cidr": cidr, "site": body.site_name, "overlaps": sites.overlapping(cidr, existing)}


@router.delete("/sites/subnets", status_code=204, dependencies=[Depends(requires("site.write"))])
async def remove_subnet(
    request: Request,
    cidr: Annotated[str, Query(min_length=9, max_length=64)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM ad_subnet WHERE cidr = $1", cidr)
        if row is None:
            raise objects.NotFound("no such subnet")
        await conn.execute("DELETE FROM ad_subnet WHERE cidr = $1", cidr)
        await _replace_sites(conn)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="site.subnet.remove",
            outcome="success",
            object_type="subnet",
            object_dn=cidr,
        )


@router.post("/sites/controllers", status_code=201,
             dependencies=[Depends(requires("site.write"))])
async def assign_controller(
    body: AssignmentIn,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Say which site a controller serves."""
    async with pool.acquire() as conn:
        if not await conn.fetchval("SELECT 1 FROM ad_site WHERE name = $1", body.site_name):
            raise objects.NotFound(f"no site called {body.site_name}")
        await conn.execute(
            """
            INSERT INTO ad_site_controller (controller_dn, site_name, hostname, assigned_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (controller_dn) DO UPDATE
                SET site_name = excluded.site_name, hostname = excluded.hostname,
                    assigned_at = now()
            """,
            body.controller_dn,
            body.site_name,
            body.hostname,
            session.principal,
        )
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="site.controller.assign",
            outcome="success",
            object_type="site",
            object_dn=body.site_name,
            after={"controller": body.controller_dn},
        )
    return {"controller_dn": body.controller_dn, "site": body.site_name}


async def _replace_sites(conn: asyncpg.Connection) -> None:
    """Re-place every machine after the subnet map changes.

    Done here rather than waiting for each agent to check in: an operator who
    has just drawn the map wants to see where machines landed.
    """
    subnets = {
        row["cidr"]: row["site_name"] for row in await conn.fetch("SELECT * FROM ad_subnet")
    }
    machines = await conn.fetch("SELECT computer_dn, addresses FROM computer_fact")
    for machine in machines:
        addresses = json.loads(machine["addresses"])
        await conn.execute(
            "UPDATE computer_fact SET site_name = $2 WHERE computer_dn = $1",
            machine["computer_dn"],
            sites.site_for(addresses, subnets),
        )
