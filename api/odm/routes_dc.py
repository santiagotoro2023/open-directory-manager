"""Domain controllers: which machines hold the directory, and how they are doing.

A read-only controller is not a setting on an existing one. Samba decides it
when a controller *joins* the domain, the same way Windows does, and there is
no supported path from writable to read-only or back. So this reports what each
controller is, and produces the command that adds a new one — rather than a
toggle that could not do what it says.
"""

from __future__ import annotations

from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query
from fastapi.concurrency import run_in_threadpool

from . import directory, objects, replication
from .config import Settings, get_settings
from .routes_directory import _read
from .security import get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/controllers", tags=["controllers"])

# userAccountControl bits on a controller's computer account.
SERVER_TRUST_ACCOUNT = 8192
PARTIAL_SECRETS_ACCOUNT = 0x04000000  # set on a read-only controller


def _controllers(conn, settings: Settings) -> list[dict[str, Any]]:
    found, _ = objects.search(
        conn,
        settings,
        object_type="computer",
        container=None,
        query=None,
        scope="subtree",
        limit=200,
    )
    controllers = []
    for entry in found:
        uac = int(entry.get("userAccountControl") or 0)
        if not uac & (SERVER_TRUST_ACCOUNT | PARTIAL_SECRETS_ACCOUNT):
            continue
        controllers.append(
            {
                "name": str(entry.get("cn") or ""),
                "fqdn": str(entry.get("dNSHostName") or ""),
                "distinguished_name": entry["distinguishedName"],
                "operating_system": str(entry.get("operatingSystem") or ""),
                # A read-only controller holds no secrets for the accounts it
                # serves, which is the whole point of putting one in a branch.
                "read_only": bool(uac & PARTIAL_SECRETS_ACCOUNT),
            }
        )
    return controllers


@router.get("", dependencies=[Depends(requires("dc.read"))])
async def list_controllers(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    controllers = await _read(settings, _controllers)

    reports = await pool.fetch(
        """
        SELECT DISTINCT ON (lower(computer_dn)) computer_dn, reported_at
        FROM agent_report ORDER BY lower(computer_dn), reported_at DESC
        """
    )
    seen = {row["computer_dn"].lower(): row["reported_at"] for row in reports}

    # Replication is asked of one controller at a time, and a controller that
    # will not answer must not stop the list rendering.
    status: dict[str, Any] = {}
    try:
        status = await run_in_threadpool(replication.status, settings)
    except Exception as exc:  # noqa: BLE001 - reported, not raised
        status = {"available": False, "detail": str(exc)}

    return {
        "controllers": [
            {**controller, "last_seen": seen.get(controller["distinguished_name"].lower())}
            for controller in controllers
        ],
        "replication": status,
        "writable": sum(1 for entry in controllers if not entry["read_only"]),
        "read_only": sum(1 for entry in controllers if entry["read_only"]),
    }


@router.get("/join-command", dependencies=[Depends(requires("dc.read"))])
async def join_command(
    hostname: Annotated[str, Query(max_length=253)] = "",
    read_only: Annotated[bool, Query()] = False,
    site: Annotated[str, Query(max_length=64)] = "Default-First-Site-Name",
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """The command that adds a controller, to run on the machine joining.

    It is produced rather than executed: this runs on a machine that is already
    a controller, and joining has to happen on the one becoming one.
    """
    role = "RODC" if read_only else "DC"
    steps = [
        "sudo apt-get install -y samba samba-ad-dc samba-ad-provision "
        "python3-samba krb5-user winbind libnss-winbind ldb-tools chrony",
        "sudo systemctl disable --now smbd nmbd winbind",
        "sudo mv /etc/samba/smb.conf /etc/samba/smb.conf.pre-join",
        (
            f"sudo samba-tool domain join {settings.domain} {role} "
            f"-U Administrator --dns-backend=SAMBA_INTERNAL "
            f'--site="{site}"'
        ),
        "sudo install -m 0644 /var/lib/samba/private/krb5.conf /etc/krb5.conf",
        "sudo systemctl enable --now samba-ad-dc",
    ]
    return {
        "hostname": hostname,
        "read_only": read_only,
        "role": role,
        "steps": steps,
        "notes": [
            "Run these on the machine becoming a controller, not on this one.",
            "Its resolver must point at an existing controller before joining, "
            "and its clock must be within five minutes of one.",
            "A read-only controller keeps no account secrets, so a branch site "
            "can authenticate without holding credentials that matter elsewhere. "
            "It cannot be converted to a writable one afterwards, or the reverse.",
        ],
    }


@router.get("/replication", dependencies=[Depends(requires("dc.read"))])
async def controller_replication(
    server: Annotated[str, Query(max_length=253)] = "",
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Inbound replication as one controller sees it."""
    return await run_in_threadpool(replication.status, settings, server or None)


@router.get("/health", dependencies=[Depends(requires("dc.read"))])
async def controller_health(
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Whether the directory answers at all, from this host."""
    try:
        conn = await run_in_threadpool(directory.service_connection, settings)
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "detail": str(exc)}
    await run_in_threadpool(conn.unbind)
    return {"available": True}
