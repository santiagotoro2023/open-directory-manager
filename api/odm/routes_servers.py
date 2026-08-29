"""The machines this domain is made of, and what each one runs.

A domain is not only its controllers. Any joined member server can carry a
role, and an operator should be able to see the whole estate — which machine
runs what, when its agent last reported — from one page rather than by
logging into each one.
"""

from __future__ import annotations

from typing import Any

import asyncpg
from fastapi import APIRouter, Depends

from . import objects
from .config import Settings, get_settings
from .routes_directory import _read
from .security import get_pool, require_admin, requires
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
