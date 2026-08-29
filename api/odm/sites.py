"""Sites and subnets: where a machine is, and which controller is near it.

A site is a place. A subnet says which addresses are in that place, and a
controller assigned to a site is one the machines there should prefer. This
is part of the directory itself rather than a role — every domain has a site
from the moment it is provisioned.

Matching is longest-prefix, the way routing is: a /24 inside a /16 wins,
because the more specific statement is the more deliberate one.
"""

from __future__ import annotations

import ipaddress
import re
from typing import Any

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$")


class SiteError(Exception):
    """The site or subnet is not one ODM will accept."""


def validate_name(name: str) -> str:
    name = (name or "").strip()
    if not _NAME_RE.match(name):
        raise SiteError(f"invalid site name {name!r}")
    return name


def validate_subnet(cidr: str) -> str:
    cidr = (cidr or "").strip()
    # A prefix is required. Without one, ipaddress reads 10.10.0.0 as a single
    # host — and somebody typing that almost certainly meant a network whose
    # size they forgot to give, not one machine.
    if "/" not in cidr:
        raise SiteError(f"{cidr!r} needs a prefix, for example {cidr}/24")
    try:
        return str(ipaddress.ip_network(cidr, strict=False))
    except ValueError as exc:
        raise SiteError(f"{cidr!r} is not a network in CIDR form") from exc


def site_for(addresses: list[str], subnets: dict[str, str]) -> str | None:
    """The site an address belongs to.

    `subnets` maps CIDR to site name. Longest prefix wins; a machine with
    several addresses is placed by the most specific match across all of them,
    so a laptop on a VPN and an office network lands where the more precise
    statement says.
    """
    best: tuple[int, str] | None = None
    for raw in addresses:
        try:
            address = ipaddress.ip_address(str(raw).strip())
        except ValueError:
            continue
        for cidr, site in subnets.items():
            try:
                network = ipaddress.ip_network(cidr, strict=False)
            except ValueError:
                continue
            if address.version != network.version or address not in network:
                continue
            if best is None or network.prefixlen > best[0]:
                best = (network.prefixlen, site)
    return best[1] if best else None


def overlapping(cidr: str, existing: list[str]) -> list[str]:
    """Subnets already covering this one, or covered by it.

    Overlap is legal — a /16 and a /24 inside it is the normal way to say
    "everything here, except that floor" — so this reports rather than
    refuses. What it prevents is an operator being surprised by it.
    """
    network = ipaddress.ip_network(validate_subnet(cidr), strict=False)
    found = []
    for other in existing:
        try:
            candidate = ipaddress.ip_network(other, strict=False)
        except ValueError:
            continue
        if candidate.version != network.version:
            continue
        if candidate.overlaps(network) and str(candidate) != str(network):
            found.append(str(candidate))
    return sorted(found)


def as_json(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": row["name"],
        "description": row["description"],
        "created_at": row["created_at"],
    }
