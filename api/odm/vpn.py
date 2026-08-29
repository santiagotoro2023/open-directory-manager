"""WireGuard tunnels: key material, addressing, and the client configuration.

Keys are generated here rather than on a node, so a peer can be created for a
machine that is not switched on and a configuration can be handed out before
the machine ever connects. WireGuard's own key format is X25519, which the
cryptography library already provides — no shelling out to wg(8), and no
custom crypto (CLAUDE.md §6).
"""

from __future__ import annotations

import base64
import ipaddress
import re
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import x25519

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$")
_HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")


class VpnError(Exception):
    """The tunnel or peer definition is not one ODM will accept."""


def keypair() -> tuple[str, str]:
    """A WireGuard private and public key, base64 as the wire format wants."""
    private = x25519.X25519PrivateKey.generate()
    private_bytes = private.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_bytes = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    return (
        base64.b64encode(private_bytes).decode("ascii"),
        base64.b64encode(public_bytes).decode("ascii"),
    )


def validate_name(name: str) -> str:
    name = (name or "").strip()
    # The name becomes a network interface and a systemd unit instance, and
    # Linux caps an interface name at 15 characters.
    if not _NAME_RE.match(name):
        raise VpnError(f"invalid name {name!r}")
    return name


def validate_endpoint(endpoint: str) -> str:
    endpoint = (endpoint or "").strip()
    if not _HOST_RE.match(endpoint):
        raise VpnError("the endpoint must be the name or address clients dial")
    return endpoint


def validate_network(network: str) -> str:
    try:
        parsed = ipaddress.ip_network(network.strip(), strict=False)
    except ValueError as exc:
        raise VpnError(f"{network!r} is not a network") from exc
    if parsed.num_addresses < 4:
        raise VpnError("the tunnel network needs room for the server and its peers")
    return str(parsed)


def validate_routes(routes: list[str] | None) -> list[str]:
    """What the tunnel carries. Empty means the tunnel's own network only."""
    validated = []
    for route in routes or []:
        try:
            validated.append(str(ipaddress.ip_network(str(route).strip(), strict=False)))
        except ValueError as exc:
            raise VpnError(f"{route!r} is not a network") from exc
    return validated


def validate_addresses(addresses: list[str] | None) -> list[str]:
    validated = []
    for address in addresses or []:
        try:
            validated.append(str(ipaddress.ip_address(str(address).strip())))
        except ValueError as exc:
            raise VpnError(f"{address!r} is not an address") from exc
    return validated


def server_address(network: str) -> str:
    """The tunnel's own address: the first usable one in its network."""
    parsed = ipaddress.ip_network(network, strict=False)
    return f"{next(parsed.hosts())}/{parsed.prefixlen}"


def next_peer_address(network: str, taken: list[str]) -> str:
    """The next free address in the tunnel's network.

    The first is the server's, so peers start one after it. Raises rather than
    wrapping round: a tunnel that has run out of addresses is a thing to be
    told about, not to paper over.
    """
    parsed = ipaddress.ip_network(network, strict=False)
    used = {str(address).split("/")[0] for address in taken}
    hosts = parsed.hosts()
    next(hosts, None)  # the server's
    for candidate in hosts:
        if str(candidate) not in used:
            return f"{candidate}/32"
    raise VpnError(f"{network} has no addresses left")


def client_config(tunnel: dict[str, Any], peer: dict[str, Any]) -> str:
    """The configuration a peer is handed.

    Plain text on purpose: it is what wg-quick, the WireGuard app on a phone,
    and NetworkManager all read, and it is what a QR code encodes.
    """
    if not peer.get("private_key"):
        raise VpnError(
            "this peer's private key was not kept, so a configuration cannot be "
            "rebuilt. Create a new peer to get one."
        )
    allowed = list(tunnel["routes"]) or [tunnel["network"]]
    lines = [
        f"# {tunnel['name']} — {peer['name']}",
        "[Interface]",
        f"Address = {peer['address']}",
        f"PrivateKey = {peer['private_key']}",
    ]
    dns = list(tunnel["dns_servers"])
    if tunnel.get("search_domain"):
        dns.append(tunnel["search_domain"])
    if dns:
        lines.append(f"DNS = {', '.join(dns)}")
    lines += [
        "",
        "[Peer]",
        f"PublicKey = {tunnel['public_key']}",
        f"Endpoint = {tunnel['endpoint']}:{tunnel['listen_port']}",
        f"AllowedIPs = {', '.join(allowed)}",
        "PersistentKeepalive = 25",
        "",
    ]
    return "\n".join(lines)


def as_task(tunnel: dict[str, Any], peers: list[dict[str, Any]]) -> dict[str, Any]:
    """What the node terminating the tunnel needs to bring it up."""
    return {
        "name": validate_name(tunnel["name"]),
        "address": server_address(tunnel["network"]),
        "listen_port": int(tunnel["listen_port"]),
        "private_key": tunnel["private_key"],
        "peers": [
            {
                "name": peer["name"],
                "public_key": peer["public_key"],
                "allowed_ips": [peer["address"]],
            }
            for peer in peers
            if peer.get("enabled", True)
        ],
    }
