"""Build the effective policy document for one target.

Loads the policy inputs from PostgreSQL and the target's facts from LDAP,
then hands both to the pure resolver in odm.policy. Used by the RSoP preview
in the UI and by the agent's own policy pull, so both see identical results.
"""

from __future__ import annotations

import json
from typing import Any

import asyncpg
from ldap3 import Connection

from . import directory, objects, policy
from .config import Settings

Inputs = tuple[dict[str, policy.Gpo], list[policy.Link], set[str]]


async def load_inputs(pool: asyncpg.Pool) -> Inputs:
    gpo_rows = await pool.fetch(
        "SELECT guid, display_name, enabled, settings, security_filter, targeting FROM gpo"
    )
    link_rows = await pool.fetch(
        "SELECT gpo_guid, target_dn, link_order, enforced, enabled FROM gpo_link"
    )
    blocked_rows = await pool.fetch(
        "SELECT ou_dn FROM ou_policy_state WHERE block_inheritance"
    )

    gpos = {
        str(row["guid"]): policy.Gpo(
            guid=str(row["guid"]),
            display_name=row["display_name"],
            enabled=row["enabled"],
            settings=json.loads(row["settings"]),
            security_filter=json.loads(row["security_filter"]),
            targeting=json.loads(row["targeting"]),
        )
        for row in gpo_rows
    }
    links = [
        policy.Link(
            gpo_guid=str(row["gpo_guid"]),
            target_dn=row["target_dn"],
            link_order=row["link_order"],
            enforced=row["enforced"],
            enabled=row["enabled"],
        )
        for row in link_rows
    ]
    return gpos, links, {row["ou_dn"] for row in blocked_rows}


def target_facts(
    conn: Connection,
    settings: Settings,
    dn: str,
    *,
    os_id: str = "",
    ip_addresses: tuple[str, ...] = (),
) -> policy.Target:
    """Facts that come from the directory; the agent supplies OS and addresses."""
    entry = objects.get(conn, settings, dn)
    hostname = str(entry.get("dNSHostName") or entry.get("cn") or "")
    groups = directory.nested_groups(conn, settings, entry["distinguishedName"])
    return policy.Target(
        dn=entry["distinguishedName"],
        hostname=hostname,
        os_id=os_id or str(entry.get("operatingSystem") or ""),
        ip_addresses=ip_addresses,
        group_dns=tuple(groups),
    )


async def build(
    pool: asyncpg.Pool,
    settings: Settings,
    conn: Connection,
    dn: str,
    *,
    os_id: str = "",
    ip_addresses: tuple[str, ...] = (),
) -> dict[str, Any]:
    gpos, links, blocked = await load_inputs(pool)
    target = target_facts(conn, settings, dn, os_id=os_id, ip_addresses=ip_addresses)
    return policy.effective_policy(
        chain=policy.container_chain(target.dn, settings.base_dn),
        links=links,
        gpos=gpos,
        blocked=blocked,
        target=target,
    )
