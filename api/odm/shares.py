"""File shares, and the access levels an operator sets on them.

ODM owns the definition (CLAUDE.md §5.5 — a role is configured through the
control plane, not by hand on the node). The node's agent renders what is
stored here into a Samba share section and into POSIX ACLs.

Access is expressed the way an operator thinks about it — read, read and
write, full control — rather than as permission bits. Each level maps to a
fixed ACL, and "inherit" adds the matching default ACL so files created in
the share afterwards carry it too. That is as close as ext4 gets to the
inheritance a Windows admin expects, and it is a real mechanism rather than
an approximation of one.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

# Samba share names, and the POSIX names ACLs are set for. Deliberately
# narrower than either allows: these values reach setfacl and a config file.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,62}$")
_PRINCIPAL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._$ -]{0,63}$")
_PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]{1,255}$")

ACCESS_LEVELS: dict[str, str] = {
    "read": "r-x",
    "change": "rwx",
    "full": "rwx",
}

ACCESS_LABELS: dict[str, str] = {
    "read": "Read",
    "change": "Read & write",
    "full": "Full control",
}

KINDS = ("user", "group")


class ShareError(Exception):
    """The share definition is not one ODM will accept."""


@dataclass(frozen=True)
class Entry:
    principal: str
    kind: str
    access: str
    inherit: bool = True

    def as_json(self) -> dict[str, Any]:
        return {
            "principal": self.principal,
            "kind": self.kind,
            "access": self.access,
            "inherit": self.inherit,
        }


def validate_name(name: str) -> str:
    name = (name or "").strip()
    if not _NAME_RE.match(name):
        raise ShareError(f"invalid share name {name!r}")
    return name


def validate_path(path: str) -> str:
    path = (path or "").strip().rstrip("/") or "/"
    if not _PATH_RE.match(path) or ".." in path:
        raise ShareError(f"invalid path {path!r}")
    # A share is a directory of its own. Handing out the root, /etc or /boot
    # over SMB is not a configuration mistake worth making reachable.
    forbidden = ("/", "/etc", "/boot", "/dev", "/proc", "/sys", "/root", "/var/lib/samba")
    if path in forbidden or any(path.startswith(f"{bad}/") for bad in forbidden[1:]):
        raise ShareError(f"{path} is not a safe directory to share")
    return path


def validate_principal(principal: str) -> str:
    principal = (principal or "").strip()
    if not _PRINCIPAL_RE.match(principal):
        raise ShareError(f"invalid name {principal!r}")
    return principal


def validate_entries(raw: list[dict[str, Any]] | str | None) -> list[Entry]:
    """The access list, from a request body or straight out of the database.

    entries is a jsonb column and asyncpg hands those back as text, so the
    caller that renders a stored share into a task passed a JSON string here.
    Iterating it walked the characters and every one of them failed on .get —
    which is why creating a share answered 500.
    """
    if isinstance(raw, str):
        raw = json.loads(raw or "[]")
    entries: list[Entry] = []
    seen: set[tuple[str, str]] = set()
    for item in raw or []:
        kind = str(item.get("kind", "group"))
        if kind not in KINDS:
            raise ShareError(f"invalid kind {kind!r}")
        access = str(item.get("access", "read"))
        if access not in ACCESS_LEVELS:
            raise ShareError(f"invalid access level {access!r}")
        principal = validate_principal(str(item.get("principal", "")))
        key = (kind, principal.lower())
        if key in seen:
            raise ShareError(f"{principal} appears twice")
        seen.add(key)
        entries.append(
            Entry(
                principal=principal,
                kind=kind,
                access=access,
                inherit=bool(item.get("inherit", True)),
            )
        )
    return entries


def acl_spec(entries: list[Entry]) -> list[str]:
    """The setfacl arguments this access list becomes.

    Returned rather than executed: the node's agent is what runs them, and a
    list of strings is something a test can assert against.
    """
    spec: list[str] = []
    for entry in entries:
        who = "u" if entry.kind == "user" else "g"
        spec.append(f"{who}:{entry.principal}:{ACCESS_LEVELS[entry.access]}")
        if entry.inherit:
            spec.append(f"d:{who}:{entry.principal}:{ACCESS_LEVELS[entry.access]}")
    return spec


def as_task(row: dict[str, Any]) -> dict[str, Any]:
    """What the agent needs to make this share real on its own machine."""
    entries = validate_entries(row.get("entries"))
    return {
        "name": validate_name(row["name"]),
        "path": validate_path(row["path"]),
        "comment": str(row.get("comment") or ""),
        "owner": validate_principal(str(row.get("owner") or "root")),
        "group": validate_principal(str(row.get("owner_group") or "Domain Admins")),
        "browseable": bool(row.get("browseable", True)),
        "read_only": bool(row.get("read_only", False)),
        "acl": acl_spec(entries),
        # Anyone not named gets nothing. Stated rather than implied, so the
        # agent does not have to infer it.
        "other": "---",
    }
