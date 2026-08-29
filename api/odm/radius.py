"""Network access: the devices that ask, and the rules that decide.

FreeRADIUS is what actually answers; ODM holds the devices and the rules and
renders them into its configuration. Authentication itself goes to the
directory — through winbind for a password, or through the certificate
authority for EAP-TLS — so there is no second place accounts live.
"""

from __future__ import annotations

import ipaddress
import re
import secrets
from typing import Any

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
# What a device sends to say which network this is: an SSID, a VPN name, a
# switch's own identifier. Free text, but it lands in a configuration file.
_NAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,62}$")


class RadiusError(Exception):
    """The client or rule is not one ODM will accept."""


def validate_name(name: str) -> str:
    name = (name or "").strip()
    if not _NAME_RE.match(name):
        raise RadiusError(f"invalid name {name!r}")
    return name


def validate_address(address: str) -> str:
    """One address or a network: a stack of switches is one entry."""
    address = (address or "").strip()
    try:
        if "/" in address:
            return str(ipaddress.ip_network(address, strict=False))
        return str(ipaddress.ip_address(address))
    except ValueError as exc:
        raise RadiusError(f"{address!r} is not an address or a network") from exc


def validate_nas_identifier(identifier: str) -> str:
    identifier = (identifier or "").strip()
    if identifier and not _NAS_RE.match(identifier):
        raise RadiusError(f"invalid network name {identifier!r}")
    return identifier


def generate_secret() -> str:
    """A shared secret for a device.

    Generated rather than typed: a device's secret is the only thing proving a
    request came from it, and one somebody chose is one somebody could guess.
    """
    return secrets.token_urlsafe(24)


def validate_secret(secret: str) -> str:
    secret = (secret or "").strip()
    if len(secret) < 16:
        raise RadiusError("a shared secret needs at least 16 characters")
    if any(character in secret for character in '"\\\n\r'):
        raise RadiusError("a shared secret cannot contain quotes, backslashes or newlines")
    return secret


def render_clients(clients: list[dict[str, Any]]) -> str:
    """The devices FreeRADIUS will answer, as its clients.conf wants them."""
    lines = ["# Managed by Open Directory Manager. Edits here are overwritten.", ""]
    for client in clients:
        name = validate_name(client["name"])
        lines += [
            f"client {name} {{",
            f"    ipaddr = {validate_address(client['address'])}",
            f'    secret = "{validate_secret(client["secret"])}"',
            "    require_message_authenticator = no",
            "    nas_type = other",
        ]
        if client.get("nas_identifier"):
            lines.append(f'    shortname = "{validate_nas_identifier(client["nas_identifier"])}"')
        lines += ["}", ""]
    return "\n".join(lines)


def render_policies(policies: list[dict[str, Any]]) -> str:
    """The rules, as an unlang policy FreeRADIUS evaluates in order.

    Deny is checked before allow at every step, matching how access decisions
    behave everywhere else in ODM: a rule that says no wins over one that says
    yes, whatever order they were written in.
    """
    lines = [
        "# Managed by Open Directory Manager. Edits here are overwritten.",
        "#",
        "# Group membership comes from the directory through winbind, so there",
        "# is no second copy of who is in what.",
        "odm_access {",
    ]

    ordered = sorted(
        (policy for policy in policies if policy.get("enabled", True)),
        # Denials first, then by the order an operator gave them.
        key=lambda policy: (policy["access"] != "deny", int(policy.get("ordering", 100))),
    )

    for policy in ordered:
        group = str(policy["group_name"] or policy["group_dn"]).replace('"', "")
        conditions = [f'&control:Auth-Type != Reject && "%{{Group-Name}}" == "{group}"']
        networks = [
            validate_nas_identifier(name) for name in policy.get("nas_identifiers", []) if name
        ]
        if networks:
            matches = " || ".join(f'"%{{NAS-Identifier}}" == "{name}"' for name in networks)
            conditions.append(f"({matches})")
        kind = policy.get("principal_kind", "user")
        if kind == "computer":
            # A machine authenticates as host/<name> or <NAME>$, never as a
            # person; matching on that is what separates the two.
            conditions.append('(&User-Name =~ /^host\\// || &User-Name =~ /\\$$/)')
        elif kind == "user":
            conditions.append('(!(&User-Name =~ /^host\\//) && !(&User-Name =~ /\\$$/))')

        lines.append(f"    # {policy['name']}")
        lines.append(f"    if ({' && '.join(conditions)}) {{")
        if policy["access"] == "deny":
            lines.append("        reject")
        else:
            lines.append("        update control { &Auth-Type := Accept }")
            if policy.get("vlan"):
                vlan = int(policy["vlan"])
                if not 1 <= vlan <= 4094:
                    raise RadiusError(f"{vlan} is not a VLAN id")
                lines += [
                    "        update reply {",
                    "            &Tunnel-Type := VLAN",
                    "            &Tunnel-Medium-Type := IEEE-802",
                    f"            &Tunnel-Private-Group-Id := {vlan}",
                    "        }",
                ]
        lines.append("    }")

    # Nothing matched means no. Stated rather than left to a default that
    # could change with a FreeRADIUS upgrade.
    lines += [
        "",
        "    if (!(&control:Auth-Type == Accept)) {",
        "        reject",
        "    }",
        "}",
        "",
    ]
    return "\n".join(lines)


def as_task(clients: list[dict[str, Any]], policies: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "clients": render_clients(clients),
        "policies": render_policies(policies),
    }
