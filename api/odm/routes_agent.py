"""Endpoints the policy agent talks to.

Agents authenticate with SPNEGO using the machine keytab that domain join
already installed — no second credential system (CLAUDE.md §2). There is no
session cookie and no CSRF token here: the Kerberos ticket is the whole
identity, and it names the computer object whose policy is being served.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from . import audit, ca, objects, routes_dc, rsop, sites, tasks
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
    # The interval is a domain setting and only a domain setting: a machine
    # polling on something nobody can see is the failure this has to avoid.
    # The control plane's configured value is the fallback, so a machine has a
    # working interval even before the schedule row exists.
    schedule = await routes_dc.agent_schedule(pool)
    document["refresh_minutes"] = schedule["poll_minutes"] or settings.agent_refresh_minutes
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
        photo = await run_in_threadpool(
            objects.photo_of, conn, settings, account["distinguishedName"]
        )
    document["target"]["machine"] = machine.dn
    # The picture belongs to the account, not to a policy object: it is the
    # same person on every machine they sign in to, which is the whole point of
    # keeping it in the directory rather than on one desktop.
    document["user"] = {"photo": photo or ""}
    return document


class SettingResult(BaseModel):
    setting: Annotated[str, Field(max_length=256)]
    # Every word the appliers use. "applied" is a setting written whether or
    # not it had changed and "unchanged" is one that was already right — and
    # because this pattern did not know them, one such result made the control
    # plane refuse the whole report with 422, so the console showed no
    # Resultant Set of Policy at all for that machine.
    status: Annotated[str, Field(pattern="^(success|applied|unchanged|failed|skipped)$")]
    reason: Annotated[str, Field(default="", max_length=512)] = ""


class LocalAdministratorCredential(BaseModel):
    """What a machine reports after rotating its own local administrator."""

    account: Annotated[str, Field(min_length=1, max_length=32)]
    password: Annotated[str, Field(min_length=8, max_length=128)]
    rotated: datetime
    expires_at: datetime


class Report(BaseModel):
    policy_serial: Annotated[str, Field(max_length=64)]
    agent_version: Annotated[str, Field(default="", max_length=32)] = ""
    applied_gpos: Annotated[list[dict[str, str]], Field(default_factory=list, max_length=200)]
    results: Annotated[list[SettingResult], Field(default_factory=list, max_length=1000)]
    local_administrator: LocalAdministratorCredential | None = None


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

    # Only on the run that rotated it. Replaced rather than appended: the
    # previous password opens nothing once the new one is set, so keeping it
    # would only widen what a copy of this table gives away.
    if body.local_administrator is not None:
        credential = body.local_administrator
        await pool.execute(
            """
            INSERT INTO local_administrator (computer_dn, account, password,
                                             rotated_at, expires_at, reported_at)
            VALUES ($1, $2, $3, $4, $5, now())
            ON CONFLICT (computer_dn) DO UPDATE SET
                account     = excluded.account,
                password    = excluded.password,
                rotated_at  = excluded.rotated_at,
                expires_at  = excluded.expires_at,
                reported_at = now()
            """,
            machine.dn,
            credential.account,
            credential.password,
            credential.rotated,
            credential.expires_at,
        )


# ------------------------------------------------------------------ tasks ---
# Work the control plane cannot do itself, because it is work on another
# machine. The agent already proves which machine it is, so it is handed only
# the tasks queued for that machine (CLAUDE.md §5.5).


# What a machine may send back about one task. The agent keeps the tail of a
# long install and reports it both while it runs and when it finishes, so both
# ends of that are bounded by this one number.
TASK_OUTPUT_LIMIT = 64_000


class TaskResult(BaseModel):
    id: Annotated[str, Field(min_length=36, max_length=36)]
    ok: bool
    # The same ceiling as the progress reports this task has been sending all
    # along, and above the agent's own. It was 8000, which a role install
    # exceeds easily: the result was refused with 422, the task stayed claimed
    # and the console said "installing" for ever with the work long finished.
    output: Annotated[str, Field(max_length=TASK_OUTPUT_LIMIT)] = ""


@router.get("/tasks")
async def agent_tasks(
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
    wait: Annotated[int, Query(ge=0, le=25)] = 0,
) -> dict[str, Any]:
    """Claim this machine's pending work, waiting for some to appear.

    An operator who clicks Restart wants the machine to restart, not to be
    told it will within half a minute. The agent leaves this request open, so
    work is picked up as it is queued rather than at the next poll. It costs
    one idle request per machine, which is what the poll cost anyway.
    """
    async with pool.acquire() as conn:
        # Once per request, not once per second: this is a write.
        await tasks.reap(conn)
        claimed = await tasks.claim(conn, machine.hostname, limit=1)
    deadline = time.monotonic() + wait
    while not claimed and time.monotonic() < deadline:
        await asyncio.sleep(1)
        async with pool.acquire() as conn:
            claimed = await tasks.claim(conn, machine.hostname, limit=1)
    return {"tasks": claimed}


class TaskProgress(BaseModel):
    id: Annotated[str, Field(min_length=36, max_length=36)]
    output: Annotated[str, Field(max_length=TASK_OUTPUT_LIMIT)] = ""


@router.post("/tasks/progress", status_code=204)
async def agent_task_progress(
    body: TaskProgress,
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """What a long task has printed so far.

    Installing a role is minutes of apt, and "installing" cannot be told apart
    from a hang. The machine's own output is put in front of the operator
    while it is still running. Never a result: the task stays claimed, and
    only /tasks/result decides how it went.
    """
    await pool.execute(
        """
        UPDATE node_task SET output = $3
        WHERE id = $1::uuid AND lower(node_fqdn) = lower($2) AND state = 'claimed'
        """,
        body.id,
        machine.hostname,
        body.output[-TASK_OUTPUT_LIMIT:],
    )


# What a task's outcome moves on. Anything the console shows a state for has
# a task with a subject, and this is where that thing learns how it went —
# without an entry here it sits at "applying" for ever, which is what a
# printer, a tunnel and a remote-desktop collection all did while the queue,
# the interface and the broker were working perfectly.
#
# Written out rather than interpolated: an identity system does not build SQL
# from a value, even one it chose itself.
FINISHED_BY_TASK = {
    "share-apply": """
        UPDATE file_share SET state = $2, last_error = $3, updated_at = now()
        WHERE id = $1::uuid
    """,
    "printer-apply": """
        UPDATE printer SET state = $2, last_error = $3, updated_at = now()
        WHERE id = $1::uuid
    """,
    "vpn-apply": """
        UPDATE vpn_tunnel SET state = $2, last_error = $3, updated_at = now()
        WHERE id = $1::uuid
    """,
    "rd-broker-apply": """
        UPDATE rd_collection SET state = $2, last_error = $3, updated_at = now()
        WHERE id = $1::uuid
    """,
    "rd-host-apply": """
        UPDATE rd_collection SET state = $2, last_error = $3, updated_at = now()
        WHERE id = $1::uuid
    """,
}


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

        # The tail, not the last line. apt's final line says only that dpkg
        # failed; the reason is the twenty lines above it, and an operator
        # reading this in the console cannot go and look at the machine.
        detail = "\n".join(body.output.strip().splitlines()[-40:])[-4000:] or None
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
        elif task["kind"] == "domain-backup" and task["subject"]:
            path, size = "", 0
            if body.ok:
                try:
                    answer = json.loads(body.output)
                    path, size = str(answer.get("path") or ""), int(answer.get("size_bytes") or 0)
                except (ValueError, TypeError):
                    path, size = "", 0
            await conn.execute(
                """
                UPDATE domain_backup
                SET state = $2, finished_at = now(), detail = $3,
                    path = CASE WHEN $4 = '' THEN path ELSE $4 END,
                    size_bytes = $5
                WHERE id = $1::uuid
                """,
                task["subject"],
                "complete" if body.ok else "failed",
                None if body.ok else detail,
                path,
                size,
            )
        elif task["subject"] and task["kind"] in FINISHED_BY_TASK:
            await conn.execute(
                FINISHED_BY_TASK[task["kind"]],
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
    # An account with no supplementary groups arrives as null, because that
    # is what an empty list is in Go. Rejecting it threw away the whole
    # inventory — every local account, session and package with it.
    groups: Annotated[
        list[Annotated[str, Field(max_length=64)]] | None, Field(max_length=64)
    ] = []

    @field_validator("groups", mode="after")
    @classmethod
    def _no_groups_is_no_groups(cls, value: list[str] | None) -> list[str]:
        return value or []


class LoginSession(BaseModel):
    user: Annotated[str, Field(max_length=64)]
    line: Annotated[str, Field(max_length=64)] = ""
    since: Annotated[str, Field(max_length=64)] = ""


class MachineEvent(BaseModel):
    kind: Annotated[str, Field(pattern="^(logon|logoff|boot|shutdown|update)$")]
    principal: Annotated[str, Field(max_length=64)] = ""
    occurred_at: datetime
    detail: Annotated[str, Field(max_length=500)] | None = None


class InstalledPackage(BaseModel):
    name: Annotated[str, Field(max_length=128)]
    version: Annotated[str, Field(max_length=64)] = ""


class LogEntry(BaseModel):
    unit: Annotated[str, Field(max_length=128)] = ""
    priority: int = 6
    message: Annotated[str, Field(max_length=2000)]
    occurred_at: datetime
    cursor: Annotated[str, Field(max_length=256)]


class PrintDevice(BaseModel):
    """One address a print server can print to, as CUPS reported it."""

    uri: Annotated[str, Field(max_length=512)]
    description: Annotated[str, Field(max_length=256)] = ""


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
    packages: Annotated[list[InstalledPackage], Field(max_length=2000)] = []
    addresses: Annotated[list[Annotated[str, Field(max_length=64)]], Field(max_length=32)] = []
    package_count: int = 0
    events: Annotated[list[MachineEvent], Field(max_length=500)] = []
    logs: Annotated[list[LogEntry], Field(max_length=500)] = []
    log_cursor: Annotated[str, Field(max_length=256)] = ""
    print_devices: Annotated[list[PrintDevice], Field(max_length=200)] = []


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
                updates, updates_checked_at, packages, package_count,
                addresses, site_name, print_devices, reported_at
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb,
                    CASE WHEN $11 THEN now() ELSE NULL END, $12::jsonb, $13,
                    $14::jsonb, $15, $16::jsonb, now())
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
                packages           = excluded.packages,
                package_count      = excluded.package_count,
                addresses          = excluded.addresses,
                site_name          = excluded.site_name,
                print_devices      = excluded.print_devices,
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
            json.dumps([package.model_dump() for package in body.packages]),
            body.package_count,
            json.dumps(body.addresses),
            # Where this machine is, from the addresses it just reported. Worked
            # out here so a machine that moves is re-placed on its next check-in
            # without anything else having to notice.
            sites.site_for(
                body.addresses,
                {
                    row["cidr"]: row["site_name"]
                    for row in await conn.fetch("SELECT cidr, site_name FROM ad_subnet")
                },
            ),
            json.dumps([device.model_dump() for device in body.print_devices]),
        )

        # A session host's logged-on users are the session directory. Derived
        # from what every machine already reports rather than a second report
        # only these machines make: the console needs to know who is on which
        # host to say where a reconnect will land.
        serves = await conn.fetchval(
            "SELECT 1 FROM rd_collection_host WHERE lower(node_fqdn) = lower($1)",
            machine.hostname,
        )
        if serves:
            await conn.execute(
                "DELETE FROM rd_session WHERE lower(node_fqdn) = lower($1)", machine.hostname
            )
            for entry in body.sessions:
                await conn.execute(
                    """
                    INSERT INTO rd_session (node_fqdn, username, display, state, reported_at)
                    VALUES ($1, $2, $3, 'active', now())
                    ON CONFLICT (node_fqdn, username) DO UPDATE SET
                        display = excluded.display, state = 'active', reported_at = now()
                    """,
                    machine.hostname,
                    entry.user,
                    entry.line,
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

        for record in body.logs:
            await conn.execute(
                """
                INSERT INTO computer_log
                    (computer_dn, hostname, unit, priority, message, occurred_at, cursor)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (computer_dn, cursor) DO NOTHING
                """,
                machine.dn,
                machine.hostname,
                record.unit,
                record.priority,
                record.message,
                record.occurred_at,
                record.cursor,
            )

        # Kept for a window and then dropped. This is a machine's recent
        # journal, not an archive, and an unbounded table would become one.
        if body.logs:
            await conn.execute(
                """
                DELETE FROM computer_log
                WHERE computer_dn = $1 AND occurred_at < now() - interval '14 days'
                """,
                machine.dn,
            )


# ------------------------------------------------------------- enrolment ----
# Certificates a machine gets without anyone issuing one by hand.
#
# The subject is never taken from the request. A machine asks for "a
# certificate", and the control plane names it from the Kerberos identity that
# asked — so a compromised agent can obtain a certificate for its own host and
# for nothing else. That is the whole security property here.


class EnrolmentRequest(BaseModel):
    profile: Annotated[str, Field(pattern="^(server|client)$")] = "server"
    validity_days: Annotated[int, Field(ge=1, le=825)] = 365
    # What the machine already holds, so a renewal is only done when due.
    current_serial: Annotated[str, Field(max_length=64)] | None = None


@router.post("/certificate", status_code=201)
async def agent_certificate(
    body: EnrolmentRequest,
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Issue this machine a certificate for itself."""
    if not ca.initialised(settings):
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            "no certificate authority has been created in this domain",
        )

    # The name comes from who asked, not from what they sent.
    common_name = machine.hostname or machine.sam_account_name.rstrip("$")
    if not common_name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "this machine has no usable name")

    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            """
            SELECT e.serial, e.not_after
            FROM enrolled_certificate e
            JOIN ca_certificate c ON c.serial = e.serial
            WHERE lower(e.computer_dn) = lower($1) AND e.profile = $2
              AND c.revoked_at IS NULL
            """,
            machine.dn,
            body.profile,
        )
        # Already holds a current one: say so rather than issuing a second.
        if existing and existing["serial"] == (body.current_serial or ""):
            return {
                "unchanged": True,
                "serial": existing["serial"],
                "not_after": existing["not_after"],
            }

        issued = await run_in_threadpool(
            ca.issue,
            settings,
            common_name=common_name,
            sans=[common_name],
            profile=body.profile,
            validity_days=body.validity_days,
        )
        await conn.execute(
            """
            INSERT INTO ca_certificate (serial, subject, sans, profile, certificate_pem,
                                        fingerprint, not_before, not_after, issued_by)
            VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
            """,
            issued.serial,
            issued.subject,
            json.dumps(issued.sans),
            body.profile,
            issued.certificate_pem,
            issued.fingerprint,
            issued.not_before,
            issued.not_after,
            f"autoenrolment:{machine.hostname}",
        )
        await conn.execute(
            """
            INSERT INTO enrolled_certificate
                (computer_dn, hostname, profile, subject, serial, not_after)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (computer_dn, profile) DO UPDATE
                SET serial = excluded.serial, subject = excluded.subject,
                    not_after = excluded.not_after, issued_at = now()
            """,
            machine.dn,
            machine.hostname,
            body.profile,
            issued.subject,
            issued.serial,
            issued.not_after,
        )
        await audit.record(
            conn,
            actor=machine.hostname,
            action="ca.autoenrol",
            outcome="success",
            object_type="certificate",
            object_dn=issued.subject,
            detail=f"{body.profile} certificate, serial {issued.serial}",
        )

    return {
        "unchanged": False,
        "serial": issued.serial,
        "subject": issued.subject,
        "not_after": issued.not_after,
        "certificate_pem": issued.certificate_pem,
        # The key is generated here with the certificate, so it travels once,
        # over the machine's own authenticated connection, and is not kept.
        "private_key_pem": issued.private_key_pem,
        "ca_pem": await run_in_threadpool(ca.root_pem, settings),
    }
