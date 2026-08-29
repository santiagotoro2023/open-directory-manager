"""The machines this domain is made of, and what each one runs.

A domain is not only its controllers. Any joined member server can carry a
role, and an operator should be able to see the whole estate — which machine
runs what, when its agent last reported — from one page rather than by
logging into each one.
"""

from __future__ import annotations

import json
import re
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from . import audit, objects, tasks
from .config import Settings, get_settings
from .routes_directory import _read
from .security import Authz, authorization, client_ip, get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/servers", tags=["servers"])

# userAccountControl bit set on a domain controller's computer account.
SERVER_TRUST_ACCOUNT = 8192


def _computers(conn, settings: Settings) -> list[dict[str, Any]]:
    found, _ = objects.search(
        conn,
        settings,
        object_type="computer",
        container=None,
        query=None,
        scope="subtree",
        limit=500,
    )
    machines = []
    for entry in found:
        uac = int(entry.get("userAccountControl") or 0)
        machines.append(
            {
                "name": str(entry.get("cn") or ""),
                "fqdn": str(entry.get("dNSHostName") or ""),
                "distinguished_name": entry["distinguishedName"],
                "operating_system": str(entry.get("operatingSystem") or ""),
                "domain_controller": bool(uac & SERVER_TRUST_ACCOUNT),
            }
        )
    return machines


@router.get("", dependencies=[Depends(requires("server.read"))])
async def list_servers(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Every joined machine, with the roles it carries and its agent's state."""
    machines = await _read(settings, _computers)

    roles = await pool.fetch(
        "SELECT role_name, node_fqdn, state FROM server_role WHERE state <> 'removed'"
    )
    reports = await pool.fetch(
        """
        SELECT DISTINCT ON (lower(computer_dn)) computer_dn, hostname, reported_at
        FROM agent_report ORDER BY lower(computer_dn), reported_at DESC
        """
    )
    pending = await pool.fetch(
        """
        SELECT lower(node_fqdn) AS node, count(*) AS waiting
        FROM node_task WHERE state IN ('pending', 'claimed') GROUP BY 1
        """
    )

    by_node: dict[str, list[dict[str, str]]] = {}
    for row in roles:
        by_node.setdefault(row["node_fqdn"].lower(), []).append(
            {"role": row["role_name"], "state": row["state"]}
        )
    seen = {row["computer_dn"].lower(): row["reported_at"] for row in reports}
    waiting = {row["node"]: row["waiting"] for row in pending}

    return {
        "servers": [
            {
                **machine,
                "roles": by_node.get(machine["fqdn"].lower(), []),
                "last_seen": seen.get(machine["distinguished_name"].lower()),
                "pending_tasks": waiting.get(machine["fqdn"].lower(), 0),
            }
            for machine in machines
            if machine["fqdn"]
        ]
    }


# ------------------------------------------------------- one machine's state --


@router.get("/computer", dependencies=[Depends(requires("server.read"))])
async def computer_detail(
    dn: Annotated[str, Query(min_length=3, max_length=1024)],
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Everything the machine has told us about itself."""
    fact = await pool.fetchrow(
        "SELECT * FROM computer_fact WHERE lower(computer_dn) = lower($1)", dn
    )
    events = await pool.fetch(
        """
        SELECT kind, principal, occurred_at, detail
        FROM computer_event WHERE lower(computer_dn) = lower($1)
        ORDER BY occurred_at DESC LIMIT 200
        """,
        dn,
    )
    queued = await pool.fetch(
        """
        SELECT id, kind, state, output, created_at, finished_at
        FROM node_task
        WHERE lower(node_fqdn) = lower(COALESCE($1, ''))
        ORDER BY created_at DESC LIMIT 20
        """,
        fact["hostname"] if fact else None,
    )

    return {
        "known": fact is not None,
        "facts": None
        if fact is None
        else {
            "hostname": fact["hostname"],
            "operating_system": fact["operating_system"],
            "kernel": fact["kernel"],
            "booted_at": fact["booted_at"],
            "local_users": json.loads(fact["local_users"]),
            "sessions": json.loads(fact["sessions"]),
            "pending_updates": fact["pending_updates"],
            "security_updates": fact["security_updates"],
            "updates": json.loads(fact["updates"]),
            "updates_checked_at": fact["updates_checked_at"],
            "packages": json.loads(fact["packages"]),
            "package_count": fact["package_count"],
            "reported_at": fact["reported_at"],
        },
        "events": [
            {
                "kind": row["kind"],
                "principal": row["principal"],
                "occurred_at": row["occurred_at"],
                "detail": row["detail"],
            }
            for row in events
        ],
        "tasks": [
            {
                "id": str(row["id"]),
                "kind": row["kind"],
                "state": row["state"],
                "output": row["output"],
                "created_at": row["created_at"],
                "finished_at": row["finished_at"],
            }
            for row in queued
        ],
    }


# Debian package names, as the archive defines them. A value from here reaches
# apt on a machine running as root, so it is checked before it is queued.
PACKAGE_RE = re.compile(r"^[a-z0-9][a-z0-9+.-]{1,127}$")

# Restarting a machine is not the same right as reading what is on it.
POWER_ACTIONS = {"restart", "shutdown"}


class ComputerAction(BaseModel):
    dn: Annotated[str, Field(min_length=3, max_length=1024)]
    action: Annotated[
        str,
        Field(
            pattern="^(update-check|update-install|package-install|package-remove"
            "|policy-refresh|restart|shutdown)$"
        ),
    ]
    package: Annotated[str, Field(max_length=128)] | None = None


@router.post("/computer/action", status_code=202,
             dependencies=[Depends(requires("computer.manage"))])
async def run_action(
    body: ComputerAction,
    request: Request,
    authz: Authz = Depends(authorization),
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Ask a machine to do something now, rather than at its next refresh."""
    if body.action in POWER_ACTIONS:
        authz.require("computer.power", body.dn)

    payload: dict[str, Any] = {}
    if body.action in ("package-install", "package-remove"):
        if not body.package or not PACKAGE_RE.match(body.package):
            raise objects.ObjectError("that is not a package name")
        payload["package"] = body.package

    async with pool.acquire() as conn:
        fact = await conn.fetchrow(
            "SELECT hostname FROM computer_fact WHERE lower(computer_dn) = lower($1)", body.dn
        )
        if fact is None:
            raise objects.NotFound(
                "this machine has not reported yet, so there is nowhere to send the request"
            )
        task_id = await tasks.enqueue(
            conn,
            node_fqdn=fact["hostname"],
            kind=body.action,
            payload=payload,
            subject=body.dn,
            requested_by=session.principal,
        )
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action=f"computer.{body.action.replace('-', '.')}",
            outcome="success",
            object_type="computer",
            object_dn=body.dn,
            detail=" ".join(filter(None, [f"queued for {fact['hostname']}", body.package])),
        )
    return {"task": task_id, "node": fact["hostname"]}


@router.get("/computer/logs", dependencies=[Depends(requires("server.read"))])
async def computer_logs(
    dn: Annotated[str, Query(min_length=3, max_length=1024)],
    hours: Annotated[int, Query(ge=1, le=336)] = 24,
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """A machine's recent journal, grouped by the unit that produced it.

    Grouped here rather than in the console: the counts are what decide which
    groups are worth opening, and computing them once beside the rows keeps the
    page from having to hold everything to work them out.
    """
    rows = await pool.fetch(
        """
        SELECT unit, priority, message, occurred_at
        FROM computer_log
        WHERE lower(computer_dn) = lower($1)
          AND occurred_at > now() - ($2 || ' hours')::interval
        ORDER BY occurred_at DESC
        LIMIT 2000
        """,
        dn,
        str(hours),
    )

    groups: dict[str, dict[str, Any]] = {}
    for row in rows:
        unit = row["unit"] or "system"
        group = groups.setdefault(unit, {"unit": unit, "errors": 0, "entries": []})
        # journalctl's priorities: 3 and below are errors, 4 is a warning.
        if row["priority"] <= 3:
            group["errors"] += 1
        group["entries"].append(
            {
                "priority": row["priority"],
                "message": row["message"],
                "occurred_at": row["occurred_at"],
            }
        )

    # Units with errors first, then by how much they had to say.
    ordered = sorted(
        groups.values(), key=lambda group: (-group["errors"], -len(group["entries"]))
    )
    for group in ordered:
        group["count"] = len(group["entries"])
    return {"hours": hours, "groups": ordered, "total": len(rows)}
