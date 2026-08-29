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

from . import admx, directory, objects, policy
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


async def load_admx(pool: asyncpg.Pool) -> dict[str, admx.Policy]:
    """Imported ADMX definitions, keyed by policy id."""
    rows = await pool.fetch(
        "SELECT id, registry_key, value_name, enabled_value, disabled_value, elements"
        " FROM admx_policy"
    )
    definitions: dict[str, admx.Policy] = {}
    for row in rows:
        definitions[row["id"]] = admx.Policy(
            id=row["id"],
            name=row["id"],
            display_name=row["id"],
            explain_text="",
            policy_class="Both",
            category="",
            registry_key=row["registry_key"],
            value_name=row["value_name"],
            supported_on="",
            enabled_value=json.loads(row["enabled_value"]) if row["enabled_value"] else None,
            disabled_value=json.loads(row["disabled_value"]) if row["disabled_value"] else None,
            elements=[admx.Element(**element) for element in json.loads(row["elements"])],
        )
    return definitions


async def apply_admx(pool: asyncpg.Pool, document: dict[str, Any]) -> None:
    """Expand ADMX selections into settings the agent understands.

    Administrative templates are a *source* of browser policy, not a separate
    thing the agent applies, so they are folded into the browser documents
    here. A selection ODM cannot map to a Debian mechanism is reported rather
    than silently dropped (CLAUDE.md §3.6).
    """
    settings = document["settings"]
    selections = settings.pop("admx", None)
    if not selections:
        return

    generated, notes = admx.expand(selections, await load_admx(pool))
    browser = settings.setdefault("browser", {})
    for name, values in generated.items():
        # Anything set explicitly on the GPO wins over the template default.
        browser[name] = {**values, **browser.get(name, {})}
    if not browser:
        settings.pop("browser", None)
    if notes:
        document["admx_notes"] = notes


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
    document = policy.effective_policy(
        chain=policy.container_chain(target.dn, settings.base_dn),
        links=links,
        gpos=gpos,
        blocked=blocked,
        target=target,
    )
    await apply_admx(pool, document)
    await attach_vpn(pool, document, target.dn)
    # The serial fingerprints what the agent will actually apply, so it is
    # recomputed after template expansion.
    document["serial"] = policy.serial(document)
    return document


async def attach_vpn(pool: asyncpg.Pool, document: dict[str, Any], dn: str) -> None:
    """Fill in the tunnel configuration for a machine told to hold one up.

    A policy object names the tunnel; it cannot carry the configuration,
    because that includes a private key belonging to one machine. It is
    attached here, where the machine asking is already known, so a key only
    ever reaches the machine it is for.
    """
    always_on = (document.get("settings") or {}).get("always_on_vpn")
    if not always_on or not always_on.get("tunnel"):
        return

    row = await pool.fetchrow(
        """
        SELECT p.address, p.private_key, p.enabled,
               t.name, t.endpoint, t.listen_port, t.public_key, t.routes,
               t.dns_servers, t.search_domain, t.network
        FROM vpn_peer p JOIN vpn_tunnel t ON t.id = p.tunnel_id
        WHERE t.name = $1 AND lower(p.principal_dn) = lower($2)
        """,
        always_on["tunnel"],
        dn,
    )
    if row is None or not row["enabled"] or not row["private_key"]:
        # No peer for this machine on that tunnel. Said plainly rather than
        # written as a configuration that cannot work.
        always_on["unavailable"] = "this machine has no peer on that tunnel"
        return

    allowed = list(row["routes"]) or [row["network"]]
    always_on["configuration"] = {
        "name": row["name"],
        "address": row["address"],
        "private_key": row["private_key"],
        "peer_public_key": row["public_key"],
        "endpoint": f"{row['endpoint']}:{row['listen_port']}",
        "allowed_ips": allowed,
        "dns": list(row["dns_servers"]),
        "search_domain": row["search_domain"],
    }
