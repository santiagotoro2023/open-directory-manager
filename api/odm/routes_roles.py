"""Server roles: what can be installed, what is installed, and installing it."""

from __future__ import annotations

import asyncio
import json
import socket
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import audit, directory, objects, replication, roles, tasks
from .config import Settings, get_settings
from .security import (
    client_ip,
    get_pool,
    require_admin,
    requires,
    requires_domain_admin,
)
from .sessions import Session

router = APIRouter(prefix="/api/v1/roles", tags=["roles"])


class InstallRequest(BaseModel):
    role: Annotated[str, Field(min_length=2, max_length=32)]
    node_fqdn: Annotated[str, Field(min_length=1, max_length=253)]
    config: dict[str, Annotated[str, Field(max_length=253)]] = Field(default_factory=dict)


def _descriptor(role: roles.Role) -> dict[str, Any]:
    return {
        "name": role.name,
        "title": role.title,
        "summary": role.summary,
        "core": role.core,
        "arguments": [
            {
                "name": argument.name,
                "label": argument.label,
                "help": argument.help,
                "kind": argument.kind,
                "choices": list(argument.choices),
                "placeholder": argument.placeholder,
                "default": argument.default,
                "optional": argument.optional,
                "configuration": argument.configuration,
            }
            for argument in role.arguments
        ],
        "packages": list(role.packages),
        "produces_settings": list(role.produces_settings),
        "ui_section": role.ui_section,
        "notes": role.notes,
    }


def _instance(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "role_name": row["role_name"],
        "node_fqdn": row["node_fqdn"],
        "state": row["state"],
        "version": row["version"],
        "config": json.loads(row["config"]),
        "last_error": row["last_error"],
        "installed_by": row["installed_by"],
        "installed_at": row["installed_at"],
        "updated_at": row["updated_at"],
    }


@router.get("", dependencies=[Depends(requires("role.read"))])
async def list_roles(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    rows = await pool.fetch("SELECT * FROM server_role ORDER BY role_name, node_fqdn")
    return {
        "available": [_descriptor(role) for role in roles.REGISTRY.values()],
        "installed": [_instance(row) for row in rows],
        "nodes": await _nodes(settings),
    }


async def _nodes(settings: Settings) -> list[str]:
    """Machines a role can be installed on: the domain's controllers.

    Reported as a list the console offers, not enforced — a role may legitimately
    run on a member server. A failure here is not worth failing the page for.
    """
    try:
        conn = await run_in_threadpool(directory.service_connection, settings)
    except Exception:  # noqa: BLE001 - the picker is a convenience, not a gate
        return []
    try:
        found = await run_in_threadpool(replication.controllers, conn, settings)
    except Exception:  # noqa: BLE001
        return []
    finally:
        await run_in_threadpool(conn.unbind)
    return sorted({dc["dns_host_name"] for dc in found if dc["dns_host_name"]})


@router.get("/instance", dependencies=[Depends(requires("role.read"))])
async def read_instance(
    id: Annotated[str, Query(min_length=36, max_length=36)],
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    row = await pool.fetchrow("SELECT * FROM server_role WHERE id = $1::uuid", id)
    if row is None:
        raise objects.NotFound("no such role instance")
    return _instance(row)


@router.post("/install", status_code=202,
             dependencies=[Depends(requires_domain_admin())])
async def install(
    body: InstallRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Start an installation and return immediately.

    Installing a role means apt work and service restarts, which take minutes.
    The request records the intent and hands back an id to poll; the state
    machine on server_role is what the UI watches.
    """
    role = roles.get(roles.validate_name(body.role))
    if role.core:
        raise objects.ObjectError("the core role is always installed")
    # Fail fast on a bad configuration, before anything is recorded.
    roles.build_command(role, body.config)

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO server_role (role_name, node_fqdn, state, config, installed_by)
            VALUES ($1, $2, 'installing', $3::jsonb, $4)
            ON CONFLICT (role_name, node_fqdn) DO UPDATE
                SET state = 'installing', config = excluded.config,
                    installed_by = excluded.installed_by, last_error = NULL,
                    updated_at = now()
            RETURNING *
            """,
            role.name,
            body.node_fqdn,
            json.dumps(body.config),
            session.principal,
        )
        if not _is_this_host(body.node_fqdn):
            await tasks.enqueue(
                conn,
                node_fqdn=body.node_fqdn,
                kind="role-install",
                payload={
                    "role": role.name,
                    "arguments": roles.installer_arguments(role, body.config),
                },
                subject=str(row["id"]),
                requested_by=session.principal,
            )
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="role.install",
            outcome="success",
            object_type="role",
            object_dn=f"{role.name}@{body.node_fqdn}",
            after={"config": body.config, "on_this_host": _is_this_host(body.node_fqdn)},
        )

    if _is_this_host(body.node_fqdn):
        asyncio.create_task(  # noqa: RUF006
            _run_install(pool, role, dict(body.config), str(row["id"]))
        )
    return {**_instance(row), "poll": "/api/v1/roles/instance"}


def _is_this_host(node_fqdn: str) -> bool:
    return node_fqdn.strip().lower().rstrip(".") == socket.getfqdn().lower().rstrip(".")


async def _run_install(
    pool: asyncpg.Pool, role: roles.Role, config: dict[str, str], instance_id: str
) -> None:
    """Run the installer and record the outcome, whichever way it goes."""
    try:
        output = await run_in_threadpool(roles.install, role, config)
    except roles.RoleError as exc:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE server_role SET state = 'failed', last_error = $2, updated_at = now()
                WHERE id = $1::uuid
                """,
                instance_id,
                str(exc)[:2000],
            )
            await audit.record(
                conn,
                actor="system",
                action="role.install",
                outcome="failure",
                object_type="role",
                object_dn=f"{role.name}@{instance_id}",
                detail=str(exc)[:500],
            )
        return

    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE server_role
            SET state = 'active', last_error = NULL, installed_at = now(), updated_at = now()
            WHERE id = $1::uuid
            """,
            instance_id,
        )
        await audit.record(
            conn,
            actor="system",
            action="role.install",
            outcome="success",
            object_type="role",
            object_dn=f"{role.name}@{instance_id}",
            detail=output.strip().splitlines()[-1][:500] if output.strip() else None,
        )


@router.delete("/instance", status_code=204,
               dependencies=[Depends(requires_domain_admin())])
async def remove_instance(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Deregister a role instance.

    This removes ODM's record of the role, not the packages on the node —
    tearing a running DHCP server down from a web UI is not something that
    should happen behind one click.
    """
    row = await pool.fetchrow("SELECT * FROM server_role WHERE id = $1::uuid", id)
    if row is None:
        raise objects.NotFound("no such role instance")
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE server_role SET state = 'removed', updated_at = now() WHERE id = $1::uuid", id
        )
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="role.remove",
            outcome="success",
            object_type="role",
            object_dn=f"{row['role_name']}@{row['node_fqdn']}",
            detail="deregistered; packages on the node are left running",
        )
