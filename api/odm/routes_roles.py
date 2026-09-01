"""Server roles: what can be installed, what is installed, and installing it."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import audit, directory, enrolment, objects, replication, roles, tasks
from . import dns as dns_module
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
        # "installing" says nothing about whether anything is happening.
        # These say whether the machine has picked the work up and when, so a
        # long install reads as a long install rather than as a hang.
        "task_state": row.get("task_state"),
        "task_started_at": row.get("task_claimed_at"),
        # What the machine has printed so far. An install is minutes of apt,
        # and its own output is the only honest answer to "is it stuck?".
        "task_output": row.get("task_output"),
    }


@router.get("", dependencies=[Depends(requires("role.read"))])
async def list_roles(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        # A machine that stopped reporting mid-install would otherwise leave
        # its role saying "installing" for ever, with nothing to retry from.
        await tasks.reap(conn)
        rows = await conn.fetch(
            """
            SELECT r.*, t.state AS task_state, t.claimed_at AS task_claimed_at,
                   t.output AS task_output
            FROM server_role r
            LEFT JOIN LATERAL (
                SELECT state, claimed_at, output FROM node_task
                WHERE subject = r.id::text AND kind = 'role-install'
                ORDER BY created_at DESC LIMIT 1
            ) t ON true
            ORDER BY r.role_name, r.node_fqdn
            """
        )
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
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Start an installation and return immediately.

    Installing a role means apt work and service restarts, which take minutes.
    The request records the intent and hands back an id to poll; the state
    machine on server_role is what the UI watches.
    """
    role = roles.get(roles.validate_name(body.role))
    if role.core:
        raise objects.ObjectError("the core role is always installed")
    # The realm, the domain and a controller are things the console knows.
    config = roles.derive(role, dict(body.config), {
        "realm": settings.realm,
        "domain": settings.domain,
        "dc_host": dns_module.server(settings),
    })
    # Network boot has to hand installed machines something to join with. An
    # operator who was never asked for a token has not got one, so issue a
    # long-lived multi-use one here rather than failing on a missing field.
    if role.name == "pxe" and not config.get("enrolment_token"):
        config["enrolment_token"] = await _issue_boot_token(pool, settings, session.principal)

    # Fail fast on a bad configuration, before anything is recorded.
    roles.build_command(role, config)

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
            json.dumps(config),
            session.principal,
        )
        # Every install runs on the target machine's agent, including when
        # that machine is this one. The control plane runs sandboxed and
        # unprivileged by design, so it cannot install packages even on its
        # own host — and a second, privileged path just for the local case is
        # a second thing to get wrong.
        await tasks.enqueue(
            conn,
            node_fqdn=body.node_fqdn,
            kind="role-install",
            payload={
                "role": role.name,
                "arguments": roles.installer_arguments(role, config),
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
            after={"config": config},
        )

    return {**_instance(row), "poll": "/api/v1/roles/instance"}


async def _issue_boot_token(
    pool: asyncpg.Pool, settings: Settings, actor: str
) -> str:
    """A multi-use enrolment token for machines installed over the network."""
    token = enrolment.new_token()
    expires_at = datetime.now().astimezone() + timedelta(days=365)
    await pool.execute(
        """
        INSERT INTO join_token (token_sha256, label, container_dn, uses_allowed,
                                expires_at, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        hashlib.sha256(token.encode()).hexdigest(),
        "Network boot",
        f"CN=Computers,{settings.base_dn}",
        # The schema caps a token at a thousand uses; network boot is the one
        # place that wants the whole allowance rather than a single machine.
        1000,
        expires_at,
        actor,
    )
    return token


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
