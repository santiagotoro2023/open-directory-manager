"""Remote desktop: collections, and the files a client connects with.

A collection is the Windows concept an administrator already has: one set of
session hosts serving the same thing to the same people, fronted by a broker
they connect to instead of a host. Everything that is a decision belongs to
the collection, because that is where it is made once for everybody. The
session host's own configuration is only what is true of that machine
whatever collection it ends up in.
"""

from __future__ import annotations

import re
from typing import Any

# //server/share, and optionally a path within it — a share that exists, made
# under File Shares. %username% is allowed anywhere in the path.
_SHARE_RE = re.compile(
    r"^//[A-Za-z0-9._-]+/[A-Za-z0-9._$ -]{1,64}(?:/[A-Za-z0-9._$%\ -]{1,64})*$"
)
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$")
_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
_FQDN_RE = re.compile(rf"^(?=.{{1,253}}$){_LABEL}(?:\.{_LABEL})+$")
_PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]{1,255}$")


class RemoteDesktopError(Exception):
    """The collection is not one ODM will accept."""


def validate_share(value: str) -> str:
    """The share holding user profile disks, or nothing.

    Empty is a collection whose sessions use whatever home the host already
    gives the user. That is the right shape for a single session host, and it
    means remote desktop does not need a file server before it works at all.
    """
    value = (value or "").strip().replace("\\", "/").rstrip("/")
    if not value:
        return ""
    if not _SHARE_RE.match(value):
        raise RemoteDesktopError(
            "the profile share must look like //server/share, optionally with a "
            "path inside it, and should be one you created under File Shares"
        )
    if any(part in (".", "..") for part in value.split("/")):
        raise RemoteDesktopError("the profile share may not contain . or ..")
    return value


def validate_name(value: str) -> str:
    value = (value or "").strip()
    if not _NAME_RE.match(value):
        raise RemoteDesktopError(f"invalid collection name {value!r}")
    return value


def validate_fqdn(value: str, what: str) -> str:
    """A host name ODM will put in a connection file or a DNS record."""
    value = (value or "").strip().rstrip(".").lower()
    if not value:
        return ""
    if not _FQDN_RE.match(value):
        raise RemoteDesktopError(f"{what} must be a fully qualified name, e.g. rd.example.org")
    return value


def dns_placement(fqdn: str) -> tuple[str, str]:
    """The record name and the zone it belongs in.

    remote.example.org is the record "remote" in the zone "example.org" — the
    same split Samba's own DNS makes, so a zone ODM creates for an external
    name is a zone samba-tool would have created.
    """
    label, _, zone = fqdn.partition(".")
    return label, zone


def connection_address(row: dict[str, Any]) -> str:
    """What a client is told to connect to.

    The external name when there is one, because that is the point of having
    one: the address in everybody's connection file stops naming the machine
    that happens to be fronting the collection today.
    """
    return (row.get("external_fqdn") or "").strip() or (row.get("broker_fqdn") or "")


def brokers(row: dict[str, Any]) -> list[str]:
    """Every machine fronting this collection, primary first.

    Both carry the same routing to the same session hosts. Which one a client
    reaches is DNS's answer, not a decision made here.
    """
    primary = (row.get("broker_fqdn") or "").strip()
    found = [primary] if primary else []
    second = (row.get("broker_secondary_fqdn") or "").strip()
    if second and second.lower() != primary.lower():
        found.append(second)
    return found


def validate_app(kind: str, path: str) -> str:
    if kind != "remoteapp":
        return ""
    path = (path or "").strip()
    if not _PATH_RE.match(path):
        raise RemoteDesktopError(
            "a published application needs the absolute path of the program to run"
        )
    return path


# Where a session host listens. The broker owns 3389 — clients connect to the
# broker, never to a host — so a machine that is both moves xrdp aside. On one
# machine they both bound 3389, xrdp won, and haproxy exited with "cannot bind
# socket (Address already in use)": the broker was not brokering at all.
DEFAULT_RDP_PORT = 3389
HOST_BESIDE_BROKER_PORT = 3390


def host_port(node_fqdn: str, *broker_fqdns: str) -> int:
    """Which port this host's xrdp listens on.

    Every broker of the collection is checked, not only the primary: a machine
    that is the standby broker owns 3389 there too, and a host sharing it has
    to move aside whether or not that broker is the one being connected to.
    """
    fronting = {(name or "").lower() for name in broker_fqdns} - {""}
    if node_fqdn.lower() in fronting:
        return HOST_BESIDE_BROKER_PORT
    return DEFAULT_RDP_PORT


def host_task(row: dict[str, Any], node_fqdn: str = "") -> dict[str, Any]:
    """What a session host is told about the collection it serves."""
    return {
        "collection": row["name"],
        "kind": row["kind"],
        "app_path": row["app_path"],
        "profile_share": row["profile_share"],
        "profile_gb": row["profile_gb"],
        # Whether a session may start without the profile it is supposed to
        # have. Off means it may not: a local home is a profile that exists on
        # one host and not the others, and somebody handed one has quietly
        # stopped keeping their work where they think it is.
        "allow_local_home": bool(row.get("allow_local_home", False)),
        "idle_minutes": row["idle_minutes"],
        "disconnected_minutes": row["disconnected_minutes"],
        "rdp_port": host_port(node_fqdn, *brokers(row)),
    }


def profile_share_entries(
    existing: list[dict[str, Any]], hosts: list[str]
) -> list[dict[str, Any]]:
    """The access list a profile share needs, given the hosts serving it.

    Nobody signing in ever authenticates to this share. The session host
    mounts it as itself, before the person has a ticket, and creates and opens
    their disk image as itself — so the machine accounts are what need access,
    and the people need none at all. A share granted to the people instead
    does not work; one granted to both lets anybody who can reach it open
    everybody else's profile.

    Each host is granted and inherits into the per-person directories it
    creates. Every other entry keeps what it has on the share itself and stops
    inheriting, so a grant made for some other purpose cannot reach inside
    somebody's profile. Nothing is removed.
    """
    machines = {host.split(".")[0].upper() + "$" for host in hosts if host}
    entries = [
        {**entry, "inherit": False}
        for entry in existing
        if str(entry.get("principal", "")).upper() not in machines
    ]
    entries.extend(
        {"principal": machine, "kind": "user", "access": "full", "inherit": True}
        for machine in sorted(machines)
    )
    return entries


def external_records(
    existing: list[dict[str, Any]], label: str, addresses: list[str]
) -> tuple[list[str], list[str]]:
    """Which A records the external name is missing, and which are stale.

    Returned as two lists rather than "rewrite the name", because a zone is
    shared: the records ODM did not put there stay where they are, and a
    collection whose brokers have not changed writes nothing at all.

    Both brokers are published under the one name. A client resolving it gets
    both addresses and tries the next when the first refuses the connection,
    which is how an RDP client has always found a second server.

    ponytail: DNS round robin, not a health check — a broker that accepts the
    connection and then fails still gets its share of clients. A floating
    address between the two nodes is the upgrade if that matters.
    """
    wanted = list(dict.fromkeys(addresses))
    have = [
        str(record.get("data", ""))
        for record in existing
        if str(record.get("name", "")).lower() == label.lower()
        and str(record.get("type", "")).upper() == "A"
    ]
    return (
        [address for address in wanted if address not in have],
        [address for address in have if address not in wanted],
    )


def broker_task(row: dict[str, Any], hosts: list[str]) -> dict[str, Any]:
    """What a broker is told: the collection, and where to send people.

    The affinity window is the collection's own disconnected timeout, not a
    number of the broker's choosing. A person whose session is still being
    held on a host must be sent back to that host: their profile disk is
    mounted there, exclusively, and landing them anywhere else would refuse
    the logon rather than start a second session.
    """
    fronting = brokers(row)
    return {
        "collection": row["name"],
        # Each host with the port its xrdp is on, so a host that shares a
        # machine with the broker is reached where it actually listens.
        "hosts": [{"host": host, "port": host_port(host, *fronting)} for host in hosts],
        "balance_method": row.get("balance_method") or "leastconn",
        "affinity_minutes": affinity_minutes(
            row.get("disconnected_minutes") or 0, row.get("idle_minutes") or 0
        ),
    }


def affinity_minutes(disconnected: int, idle: int) -> int:
    """How long the broker keeps sending one person back to the same host.

    Long enough to cover a session that may still exist, and no longer: an
    entry that outlives the session pins somebody to a host for no reason,
    and one that expires first sends them to a host that cannot mount their
    profile because the old host still has it.
    """
    if disconnected == 0:
        # Sessions are kept indefinitely, so the affinity has to be too. A
        # week is the longest haproxy will hold a stick entry usefully, and
        # anything staler than that is a session nobody is coming back to.
        return 7 * 24 * 60
    # A little past the timeout, because the host ends the session on its own
    # clock and the two are not synchronised to the second.
    return disconnected + max(idle, 5) + 5


def rdp_file(
    *,
    broker: str,
    username: str,
    collection: dict[str, Any],
    full_address_port: int = 3389,
) -> str:
    """The .rdp a client opens.

    The user name matters beyond convenience: an RDP client sends it in the
    first packet, and that is the value the broker keys its affinity on. A
    file without it would connect somebody to whichever host was least busy
    each time, which is the opposite of what a collection is for.
    """
    lines = [
        f"full address:s:{broker}:{full_address_port}",
        f"username:s:{username}",
        "prompt for credentials:i:0",
        "authentication level:i:2",
        "negotiate security layer:i:1",
        "screen mode id:i:2",
        "session bpp:i:32",
        "compression:i:1",
        "bitmapcachepersistenable:i:1",
        "audiomode:i:0",
        "redirectclipboard:i:1",
        "redirectprinters:i:1",
        "redirectsmartcards:i:0",
        "drivestoredirect:s:",
        "autoreconnection enabled:i:1",
    ]
    if collection.get("kind") == "remoteapp":
        # RemoteApp: the client shows one window rather than a desktop.
        lines += [
            "remoteapplicationmode:i:1",
            f"remoteapplicationname:s:{collection.get('app_name') or collection['name']}",
            f"remoteapplicationprogram:s:{collection.get('app_path') or ''}",
            f"alternate shell:s:{collection.get('app_path') or ''}",
        ]
    # CRLF: this is a Windows file format and some clients are strict about it.
    return "\r\n".join(lines) + "\r\n"
