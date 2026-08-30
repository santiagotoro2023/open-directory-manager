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

# //server/share — a share that exists, made under File Shares.
_SHARE_RE = re.compile(r"^//[A-Za-z0-9._-]+/[A-Za-z0-9._$ -]{1,64}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$")
_PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]{1,255}$")


class RemoteDesktopError(Exception):
    """The collection is not one ODM will accept."""


def validate_share(value: str) -> str:
    value = (value or "").strip().replace("\\", "/")
    if not _SHARE_RE.match(value):
        raise RemoteDesktopError(
            "the profile share must look like //server/share, and should be one "
            "you created under File Shares"
        )
    return value


def validate_name(value: str) -> str:
    value = (value or "").strip()
    if not _NAME_RE.match(value):
        raise RemoteDesktopError(f"invalid collection name {value!r}")
    return value


def validate_app(kind: str, path: str) -> str:
    if kind != "remoteapp":
        return ""
    path = (path or "").strip()
    if not _PATH_RE.match(path):
        raise RemoteDesktopError(
            "a published application needs the absolute path of the program to run"
        )
    return path


def host_task(row: dict[str, Any]) -> dict[str, Any]:
    """What a session host is told about the collection it serves."""
    return {
        "collection": row["name"],
        "kind": row["kind"],
        "app_path": row["app_path"],
        "profile_share": row["profile_share"],
        "profile_gb": row["profile_gb"],
        "idle_minutes": row["idle_minutes"],
        "disconnected_minutes": row["disconnected_minutes"],
    }


def broker_task(row: dict[str, Any], hosts: list[str]) -> dict[str, Any]:
    """What a broker is told: the collection, and where to send people."""
    return {"collection": row["name"], "hosts": hosts}


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
