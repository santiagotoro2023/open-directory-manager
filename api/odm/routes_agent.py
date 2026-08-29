"""Endpoints the policy agent talks to.

Agents authenticate with SPNEGO using the machine keytab that domain join
already installed — no second credential system (CLAUDE.md §2). There is no
session cookie and no CSRF token here: the Kerberos ticket is the whole
identity, and it names the computer object whose policy is being served.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import audit, objects, rsop, tasks
from .auth import _accept_spnego
from .config import Settings, get_settings
from .routes_directory import _bound
from .security import get_pool

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])


@dataclass(frozen=True)
class Machine:
    dn: str
    hostname: str
    sam_account_name: str


async def require_machine(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> Machine:
    if settings.keytab is None:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "no service keytab configured")

    header = request.headers.get("authorization", "")
    scheme, _, payload = header.partition(" ")
    if scheme.lower() != "negotiate" or not payload:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "kerberos ticket required",
            headers={"WWW-Authenticate": "Negotiate"},
        )
    try:
        token = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "malformed negotiate token") from exc

    principal, _out = await run_in_threadpool(_accept_spnego, settings, token)
    name = principal.split("@", 1)[0]
    # host/ws01.corp.example.internal (service principal) or WS01$ (machine account)
    dns_host_name = name.split("/", 1)[1] if "/" in name else None
    sam_account_name = None if dns_host_name else name

    async with _bound(settings, write=False) as conn:
        computer = await run_in_threadpool(
            objects.find_computer,
            conn,
            settings,
            sam_account_name=sam_account_name,
            dns_host_name=dns_host_name,
        )
    return Machine(
        dn=computer["distinguishedName"],
        hostname=str(computer.get("dNSHostName") or computer.get("cn") or ""),
        sam_account_name=str(computer.get("sAMAccountName") or ""),
    )


@router.get("/policy")
async def agent_policy(
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
    os_id: Annotated[str, Query(alias="os", max_length=64)] = "",
    ip: Annotated[list[str] | None, Query(max_length=16)] = None,
) -> dict[str, Any]:
    """The flattened effective policy for the calling machine.

    Precedence, inheritance, enforcement, security filtering and item-level
    targeting are all resolved here; the agent applies what it is handed.
    """
    async with _bound(settings, write=False) as conn:
        document = await rsop.build(
            pool,
            settings,
            conn,
            machine.dn,
            os_id=os_id,
            ip_addresses=tuple(ip or ()),
        )
    document["refresh_minutes"] = (
        document["settings"].get("agent", {}).get("refresh_minutes")
        or settings.agent_refresh_minutes
    )
    return document


@router.get("/user-policy")
async def agent_user_policy(
    user: Annotated[str, Query(min_length=1, max_length=104)],
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Policy for one user logging on to the calling machine.

    AD resolves computer and user policy separately; so does ODM. The machine
    asks on the user's behalf using its own ticket, so a user never needs
    credentials of their own against the API.
    """
    async with _bound(settings, write=False) as conn:
        account = await run_in_threadpool(objects.find_user, conn, settings, user)
        document = await rsop.build(pool, settings, conn, account["distinguishedName"])
    document["target"]["machine"] = machine.dn
    return document


class SettingResult(BaseModel):
    setting: Annotated[str, Field(max_length=256)]
    status: Annotated[str, Field(pattern="^(success|failed|skipped)$")]
    reason: Annotated[str, Field(default="", max_length=512)] = ""


class Report(BaseModel):
    policy_serial: Annotated[str, Field(max_length=64)]
    agent_version: Annotated[str, Field(default="", max_length=32)] = ""
    applied_gpos: Annotated[list[dict[str, str]], Field(default_factory=list, max_length=200)]
    results: Annotated[list[SettingResult], Field(default_factory=list, max_length=1000)]


@router.post("/report", status_code=204)
async def agent_report(
    body: Report,
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Resultant Set of Policy, as observed by the machine that applied it."""
    results = [result.model_dump() for result in body.results]
    await pool.execute(
        """
        INSERT INTO agent_report (computer_dn, hostname, agent_version, policy_serial,
                                  applied_gpos, results, failures)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
        """,
        machine.dn,
        machine.hostname,
        body.agent_version,
        body.policy_serial,
        json.dumps(body.applied_gpos),
        json.dumps(results),
        sum(1 for result in results if result["status"] == "failed"),
    )


# ------------------------------------------------------------------ tasks ---
# Work the control plane cannot do itself, because it is work on another
# machine. The agent already proves which machine it is, so it is handed only
# the tasks queued for that machine (CLAUDE.md §5.5).


class TaskResult(BaseModel):
    id: Annotated[str, Field(min_length=36, max_length=36)]
    ok: bool
    output: Annotated[str, Field(max_length=8000)] = ""


@router.get("/tasks")
async def agent_tasks(
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Claim this machine's pending work."""
    async with pool.acquire() as conn:
        return {"tasks": await tasks.claim(conn, machine.hostname)}


@router.post("/tasks/result", status_code=204)
async def agent_task_result(
    body: TaskResult,
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Record how a task went, and move whatever it was for to its new state."""
    async with pool.acquire() as conn:
        task = await tasks.finish(
            conn, body.id, machine.hostname, ok=body.ok, output=body.output
        )
        if task is None:
            # Not this machine's task, or already reported. Nothing to record.
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such task")

        detail = body.output.strip().splitlines()[-1][:500] if body.output.strip() else None
        if task["kind"] == "role-install" and task["subject"]:
            await conn.execute(
                """
                UPDATE server_role
                SET state = $2, last_error = $3,
                    installed_at = CASE WHEN $2 = 'active' THEN now() ELSE installed_at END,
                    updated_at = now()
                WHERE id = $1::uuid
                """,
                task["subject"],
                "active" if body.ok else "failed",
                None if body.ok else detail,
            )
        elif task["kind"] == "share-apply" and task["subject"]:
            await conn.execute(
                """
                UPDATE file_share SET state = $2, last_error = $3, updated_at = now()
                WHERE id = $1::uuid
                """,
                task["subject"],
                "active" if body.ok else "failed",
                None if body.ok else detail,
            )

        await audit.record(
            conn,
            actor=machine.hostname,
            action=f"agent.{task['kind'].replace('-', '.')}",
            outcome="success" if body.ok else "failure",
            object_type="node-task",
            object_dn=task["subject"],
            detail=detail,
        )


# -------------------------------------------------------------- inventory ---
# What the directory cannot know about a machine: who is on it, when it
# booted, which local accounts it carries, what updates are waiting.


class LocalUser(BaseModel):
    name: Annotated[str, Field(max_length=64)]
    uid: int
    shell: Annotated[str, Field(max_length=128)] = ""
    home: Annotated[str, Field(max_length=255)] = ""
    groups: Annotated[list[Annotated[str, Field(max_length=64)]], Field(max_length=64)] = []


class LoginSession(BaseModel):
    user: Annotated[str, Field(max_length=64)]
    line: Annotated[str, Field(max_length=64)] = ""
    since: Annotated[str, Field(max_length=64)] = ""


class MachineEvent(BaseModel):
    kind: Annotated[str, Field(pattern="^(logon|logoff|boot|shutdown|update)$")]
    principal: Annotated[str, Field(max_length=64)] = ""
    occurred_at: datetime
    detail: Annotated[str, Field(max_length=500)] | None = None


class Inventory(BaseModel):
    operating_system: Annotated[str, Field(max_length=128)] = ""
    kernel: Annotated[str, Field(max_length=128)] = ""
    booted_at: datetime | None = None
    local_users: Annotated[list[LocalUser], Field(max_length=500)] = []
    sessions: Annotated[list[LoginSession], Field(max_length=200)] = []
    pending_updates: int = 0
    security_updates: int = 0
    updates: Annotated[list[Annotated[str, Field(max_length=128)]], Field(max_length=500)] = []
    updates_checked: bool = False
    events: Annotated[list[MachineEvent], Field(max_length=500)] = []


@router.post("/inventory", status_code=204)
async def agent_inventory(
    body: Inventory,
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Record what the machine reports about itself."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO computer_fact (
                computer_dn, hostname, operating_system, kernel, booted_at,
                local_users, sessions, pending_updates, security_updates,
                updates, updates_checked_at, reported_at
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb,
                    CASE WHEN $11 THEN now() ELSE NULL END, now())
            ON CONFLICT (computer_dn) DO UPDATE SET
                hostname           = excluded.hostname,
                operating_system   = excluded.operating_system,
                kernel             = excluded.kernel,
                booted_at          = excluded.booted_at,
                local_users        = excluded.local_users,
                sessions           = excluded.sessions,
                pending_updates    = excluded.pending_updates,
                security_updates   = excluded.security_updates,
                updates            = excluded.updates,
                updates_checked_at = COALESCE(excluded.updates_checked_at,
                                              computer_fact.updates_checked_at),
                reported_at        = now()
            """,
            machine.dn,
            machine.hostname,
            body.operating_system,
            body.kernel,
            body.booted_at,
            json.dumps([user.model_dump() for user in body.local_users]),
            json.dumps([session.model_dump() for session in body.sessions]),
            body.pending_updates,
            body.security_updates,
            json.dumps(body.updates),
            body.updates_checked,
        )

        # A report covers a window, so the same login arrives more than once.
        # The unique constraint is what makes that harmless.
        for event in body.events:
            await conn.execute(
                """
                INSERT INTO computer_event
                    (computer_dn, hostname, kind, principal, occurred_at, detail)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (computer_dn, kind, principal, occurred_at) DO NOTHING
                """,
                machine.dn,
                machine.hostname,
                event.kind,
                event.principal,
                event.occurred_at,
                event.detail,
            )
