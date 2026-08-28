"""Mirror ODM policy objects into real AD structures.

ODM's settings themselves live in PostgreSQL — systemd units, drive maps and
Linux sudo scope have no native GPO representation. What is mirrored is the
*structure*: a groupPolicyContainer per GPO, gPLink on each linked OU and
gPOptions for block-inheritance, so a domain managed by ODM still looks like
a domain to GPMC/RSAT (CLAUDE.md §5.2).

The mirror is all-or-nothing, gated on ODM_SYSVOL_PATH being configured: a
groupPolicyContainer whose gPCFileSysPath does not exist is worse than no
object at all, so if ODM cannot write SYSVOL it does not write LDAP either.

ponytail: the SYSVOL side writes GPT.INI and the Machine/User skeleton, not
registry.pol — ODM's own settings are not registry-shaped. Generating
registry.pol belongs with the ADMX importer in Phase 5.
"""

from __future__ import annotations

import re
from pathlib import Path

from ldap3 import MODIFY_REPLACE, Connection

from .config import Settings

GPO_GUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")

# gPLink option bits.
LINK_DISABLED = 1
LINK_ENFORCED = 2
# gPOptions on a container.
BLOCK_INHERITANCE = 1


def enabled(settings: Settings) -> bool:
    return settings.sysvol_path is not None


def policies_container(settings: Settings) -> str:
    return f"CN=Policies,CN=System,{settings.base_dn}"


def gpo_dn(settings: Settings, guid: str) -> str:
    if not GPO_GUID_RE.match(guid):
        raise ValueError("invalid GPO guid")
    return f"CN={{{guid.upper()}}},{policies_container(settings)}"


def file_sys_path(settings: Settings, guid: str) -> str:
    return f"\\\\{settings.domain}\\SysVol\\{settings.domain}\\Policies\\{{{guid.upper()}}}"


def create(conn: Connection, settings: Settings, guid: str, display_name: str) -> None:
    if not enabled(settings):
        return
    dn = gpo_dn(settings, guid)
    conn.add(
        dn,
        ["top", "container", "groupPolicyContainer"],
        {
            "displayName": display_name,
            "gPCFileSysPath": file_sys_path(settings, guid),
            "gPCFunctionalityVersion": 2,
            "flags": 0,
            "versionNumber": 0,
        },
    )
    for half in ("Machine", "User"):
        conn.add(f"CN={half},{dn}", ["top", "container"], {})
    _write_sysvol(settings, guid)


def rename(conn: Connection, settings: Settings, guid: str, display_name: str) -> None:
    if not enabled(settings):
        return
    conn.modify(
        gpo_dn(settings, guid), {"displayName": [(MODIFY_REPLACE, [display_name])]}
    )


def bump_version(conn: Connection, settings: Settings, guid: str, version: int) -> None:
    """Keep versionNumber and GPT.INI in step, the way real tooling expects."""
    if not enabled(settings):
        return
    conn.modify(gpo_dn(settings, guid), {"versionNumber": [(MODIFY_REPLACE, [version])]})
    _write_sysvol(settings, guid, version)


def delete(conn: Connection, settings: Settings, guid: str) -> None:
    if not enabled(settings):
        return
    dn = gpo_dn(settings, guid)
    for half in ("Machine", "User"):
        conn.delete(f"CN={half},{dn}")
    conn.delete(dn)
    directory = _sysvol_dir(settings, guid)
    if directory and directory.exists():
        for child in sorted(directory.rglob("*"), reverse=True):
            child.rmdir() if child.is_dir() else child.unlink()
        directory.rmdir()


def render_gplink(settings: Settings, links: list[dict]) -> str:
    """Build a gPLink value from ODM's links.

    In gPLink the *last* entry has the highest precedence, while ODM (like
    GPMC) shows link order 1 as highest, so the string is written in
    descending link order.
    """
    parts = []
    for link in sorted(links, key=lambda link: -int(link["link_order"])):
        options = 0
        if not link.get("enabled", True):
            options |= LINK_DISABLED
        if link.get("enforced"):
            options |= LINK_ENFORCED
        parts.append(f"[LDAP://{gpo_dn(settings, str(link['gpo_guid']))};{options}]")
    return "".join(parts)


def write_links(conn: Connection, settings: Settings, target_dn: str, links: list[dict]) -> None:
    if not enabled(settings):
        return
    value = render_gplink(settings, links)
    conn.modify(target_dn, {"gPLink": [(MODIFY_REPLACE, [value] if value else [])]})


def write_inheritance(conn: Connection, settings: Settings, ou_dn: str, blocked: bool) -> None:
    if not enabled(settings):
        return
    conn.modify(
        ou_dn, {"gPOptions": [(MODIFY_REPLACE, [BLOCK_INHERITANCE if blocked else 0])]}
    )


def _sysvol_dir(settings: Settings, guid: str) -> Path | None:
    if settings.sysvol_path is None:
        return None
    return Path(settings.sysvol_path) / f"{{{guid.upper()}}}"


def _write_sysvol(settings: Settings, guid: str, version: int = 0) -> None:
    directory = _sysvol_dir(settings, guid)
    if directory is None:
        return
    (directory / "Machine").mkdir(parents=True, exist_ok=True)
    (directory / "User").mkdir(parents=True, exist_ok=True)
    (directory / "GPT.INI").write_text(f"[General]\nVersion={version}\n", encoding="utf-8")
