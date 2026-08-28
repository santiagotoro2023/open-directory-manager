"""Group Policy precedence resolution and settings merge.

Pure functions: no database, no LDAP, no I/O. Precedence is the part of a
policy system that is easiest to get subtly wrong and hardest to debug in
the field, so it lives here, resolved once in the API, and the agent applies
whatever it is handed (CLAUDE.md §5.2).

AD semantics implemented:
  * Link order within a container — order 1 has the highest precedence, so
    links are *applied* in descending order and the lowest number wins.
  * Inheritance — containers are processed from the domain head down, so a
    link closer to the object overrides one further away.
  * Block inheritance — an OU with the flag set discards everything
    inherited from above it, except enforced links.
  * Enforced ("No Override") — applied after everything else, and among
    enforced links the one highest in the hierarchy wins.
  * Security filtering and item-level targeting decide whether a GPO is in
    scope for this particular target at all.
"""

from __future__ import annotations

import fnmatch
import hashlib
import ipaddress
import json
from dataclasses import dataclass, field
from typing import Any

# Category -> the field that identifies one entry within it. Two GPOs that
# both set the same identity collide, and the winner is the one applied last.
LIST_KEYS: dict[str, tuple[str, ...]] = {
    "files": ("path",),
    "scripts": ("trigger", "name"),
    "systemd_units": ("unit",),
    "cron": ("name",),
    "firewall": ("name",),
    "drive_maps": ("mount_point",),
    "sudo_rules": ("name",),
    "logon_rights": ("principal", "service"),
    "admx": ("policy_id",),
}

# Categories that are objects rather than lists; merged one level deep.
DICT_CATEGORIES = ("browser", "wallpaper", "agent")

CATEGORIES = (*LIST_KEYS, *DICT_CATEGORIES)


@dataclass(frozen=True)
class Gpo:
    guid: str
    display_name: str
    enabled: bool
    settings: dict[str, Any]
    security_filter: list[str] = field(default_factory=list)
    targeting: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Link:
    gpo_guid: str
    target_dn: str
    link_order: int
    enforced: bool = False
    enabled: bool = True


@dataclass(frozen=True)
class Target:
    """Everything a filtering or targeting decision can depend on."""

    dn: str
    hostname: str = ""
    os_id: str = ""
    ip_addresses: tuple[str, ...] = ()
    group_dns: tuple[str, ...] = ()


def container_chain(dn: str, base_dn: str) -> list[str]:
    """Domain head first, immediate parent last.

    CN=ws01,OU=Sales,OU=Corp,DC=x,DC=y with base DC=x,DC=y gives
    [DC=x,DC=y, OU=Corp,DC=x,DC=y, OU=Sales,OU=Corp,DC=x,DC=y].
    """
    if not dn.lower().endswith(base_dn.lower()):
        return []
    relative = dn[: -(len(base_dn) + 1)] if len(dn) > len(base_dn) else ""
    parts = _split_dn(relative)[1:]  # drop the object's own RDN
    chain = [base_dn]
    for index in range(len(parts) - 1, -1, -1):
        chain.append(",".join(parts[index:] + [base_dn]))
    return chain


def _split_dn(dn: str) -> list[str]:
    """Split on unescaped commas."""
    parts: list[str] = []
    current = ""
    escaped = False
    for char in dn:
        if escaped:
            current += char
            escaped = False
        elif char == "\\":
            current += char
            escaped = True
        elif char == ",":
            parts.append(current)
            current = ""
        else:
            current += char
    if current:
        parts.append(current)
    return parts


def in_scope(gpo: Gpo, target: Target) -> tuple[bool, str]:
    """Security filtering plus item-level targeting. Returns (applies, why)."""
    if not gpo.enabled:
        return False, "gpo disabled"

    groups = {g.lower() for g in target.group_dns}
    if gpo.security_filter:
        allowed = {principal.lower() for principal in gpo.security_filter}
        if target.dn.lower() not in allowed and not (allowed & groups):
            return False, "security filtering"

    targeting = gpo.targeting or {}

    wanted_os = targeting.get("os")
    if wanted_os and target.os_id not in wanted_os:
        return False, "os targeting"

    pattern = targeting.get("hostname_pattern")
    if pattern and not fnmatch.fnmatch(target.hostname.lower(), str(pattern).lower()):
        return False, "hostname targeting"

    wanted_groups = targeting.get("security_groups")
    if wanted_groups and not ({g.lower() for g in wanted_groups} & groups):
        return False, "group targeting"

    ranges = targeting.get("ip_ranges")
    if ranges and not _ip_matches(target.ip_addresses, ranges):
        return False, "ip targeting"

    return True, ""


def _ip_matches(addresses: tuple[str, ...], ranges: list[str]) -> bool:
    networks = []
    for entry in ranges:
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            continue  # a malformed range never matches, it does not crash policy
    for address in addresses:
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            continue
        if any(parsed in network for network in networks):
            return True
    return False


def resolve_order(
    *,
    chain: list[str],
    links: list[Link],
    gpos: dict[str, Gpo],
    blocked: set[str],
    target: Target,
) -> tuple[list[Gpo], list[dict[str, str]]]:
    """Order the GPOs that apply to a target, lowest precedence first.

    Also returns the GPOs that were considered and skipped, with the reason,
    so RSoP can explain an absence as well as a presence.
    """
    blocked_lower = {b.lower() for b in blocked}
    by_target: dict[str, list[Link]] = {}
    for link in links:
        by_target.setdefault(link.target_dn.lower(), []).append(link)

    normal: list[tuple[int, Gpo]] = []
    enforced: list[tuple[int, Gpo]] = []
    skipped: list[dict[str, str]] = []

    for depth, container in enumerate(chain):
        # Lowest link order wins, so apply in descending order.
        for link in sorted(by_target.get(container.lower(), []), key=lambda ln: -ln.link_order):
            gpo = gpos.get(link.gpo_guid)
            if gpo is None:
                continue
            if not link.enabled:
                skipped.append({"guid": link.gpo_guid, "name": gpo.display_name,
                                "reason": "link disabled"})
                continue
            applies, reason = in_scope(gpo, target)
            if not applies:
                skipped.append({"guid": gpo.guid, "name": gpo.display_name, "reason": reason})
                continue
            (enforced if link.enforced else normal).append((depth, gpo))

    deepest_blocked = max(
        (index for index, container in enumerate(chain) if container.lower() in blocked_lower),
        default=None,
    )
    if deepest_blocked is not None:
        for depth, gpo in normal:
            if depth < deepest_blocked:
                skipped.append(
                    {"guid": gpo.guid, "name": gpo.display_name, "reason": "inheritance blocked"}
                )
        normal = [(depth, gpo) for depth, gpo in normal if depth >= deepest_blocked]

    # Enforced links go last, and the one highest in the hierarchy goes last
    # of all so that it wins.
    ordered = [gpo for _, gpo in normal]
    ordered += [gpo for _, gpo in sorted(enforced, key=lambda pair: -pair[0])]
    return ordered, skipped


def merge_settings(gpos: list[Gpo]) -> dict[str, Any]:
    """Flatten ordered GPO settings into one document; later GPOs win."""
    merged: dict[str, Any] = {}
    sources: dict[str, str] = {}

    for gpo in gpos:
        for category, value in (gpo.settings or {}).items():
            if category in LIST_KEYS and isinstance(value, list):
                bucket: dict[str, dict] = merged.setdefault(category, {})
                for item in value:
                    if not isinstance(item, dict):
                        continue
                    bucket[_identity(category, item)] = item
                    sources[f"{category}:{_identity(category, item)}"] = gpo.guid
            elif category in DICT_CATEGORIES and isinstance(value, dict):
                target = merged.setdefault(category, {})
                for key, sub in value.items():
                    if isinstance(sub, dict) and isinstance(target.get(key), dict):
                        target[key] = {**target[key], **sub}
                    else:
                        target[key] = sub
                    sources[f"{category}.{key}"] = gpo.guid
            else:
                merged[category] = value
                sources[category] = gpo.guid

    for category in LIST_KEYS:
        if category in merged:
            merged[category] = list(merged[category].values())
    return merged


def _identity(category: str, item: dict) -> str:
    keys = LIST_KEYS[category]
    return "|".join(str(item.get(key, "")) for key in keys)


def effective_policy(
    *,
    chain: list[str],
    links: list[Link],
    gpos: dict[str, Gpo],
    blocked: set[str],
    target: Target,
) -> dict[str, Any]:
    """The document handed to an agent: settings plus the reasoning behind them."""
    ordered, skipped = resolve_order(
        chain=chain, links=links, gpos=gpos, blocked=blocked, target=target
    )
    settings = merge_settings(ordered)
    applied = [{"guid": gpo.guid, "name": gpo.display_name} for gpo in ordered]
    document = {
        "target": {"dn": target.dn, "hostname": target.hostname, "os": target.os_id},
        "applied_gpos": applied,
        "skipped_gpos": skipped,
        "settings": settings,
    }
    document["serial"] = serial(document)
    return document


def serial(document: dict[str, Any]) -> str:
    """Stable fingerprint so an agent can skip an unchanged policy."""
    payload = json.dumps(
        {"applied": document.get("applied_gpos"), "settings": document.get("settings")},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:32]
