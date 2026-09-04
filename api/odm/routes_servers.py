"""The machines this domain is made of, and what each one runs.

A domain is not only its controllers. Any joined member server can carry a
role, and an operator should be able to see the whole estate — which machine
runs what, when its agent last reported — from one page rather than by
logging into each one.
"""

from __future__ import annotations

import json
import re
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import agents, agentupdate, audit, objects, tasks
from .config import Settings, get_settings
from .routes_directory import _read
from .security import Authz, authorization, client_ip, get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/servers", tags=["servers"])

# userAccountControl bit set on a domain controller's computer account.
SERVER_TRUST_ACCOUNT = 8192


def _computers(conn, settings: Settings) -> list[dict[str, Any]]:
    found, _ = objects.search(
        conn,
        settings,
        object_type="computer",
        container=None,
        query=None,
        scope="subtree",
        limit=500,
    )
    machines = []
    for entry in found:
        uac = int(entry.get("userAccountControl") or 0)
        machines.append(
            {
                "name": str(entry.get("cn") or ""),
                "fqdn": str(entry.get("dNSHostName") or ""),
                "distinguished_name": entry["distinguishedName"],
                "operating_system": str(entry.get("operatingSystem") or ""),
                "domain_controller": bool(uac & SERVER_TRUST_ACCOUNT),
            }
        )
    return machines


# A machine's facts are stored against the DN it reported. Moving it to
# another organizational unit changes that DN, and until it next reports the
# console could not find it at all: "this machine has not reported yet" about
# a machine that had been reporting for weeks. Its name does not change when
# it moves, so that is the fallback.
FACTS_BY_DN = """
    SELECT * FROM computer_fact
    WHERE lower(computer_dn) = lower($1)
       OR lower(split_part(computer_dn, ',', 1)) = lower(split_part($1, ',', 1))
    ORDER BY (lower(computer_dn) = lower($1)) DESC
    LIMIT 1
"""

HOSTNAME_BY_DN = """
    SELECT hostname FROM computer_fact
    WHERE lower(computer_dn) = lower($1)
       OR lower(split_part(computer_dn, ',', 1)) = lower(split_part($1, ',', 1))
    ORDER BY (lower(computer_dn) = lower($1)) DESC
    LIMIT 1
"""

@router.get("", dependencies=[Depends(requires("server.read"))])
async def list_servers(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Every joined machine, with the roles it carries and its agent's state."""
    machines = await _read(settings, _computers)

    roles = await pool.fetch(
        "SELECT role_name, node_fqdn, state FROM server_role WHERE state <> 'removed'"
    )
    contact = await agents.last_contact(pool)
    pending = await pool.fetch(
        """
        SELECT lower(node_fqdn) AS node, count(*) AS waiting
        FROM node_task WHERE state IN ('pending', 'claimed') GROUP BY 1
        """
    )

    by_node: dict[str, list[dict[str, str]]] = {}
    for row in roles:
        by_node.setdefault(row["node_fqdn"].lower(), []).append(
            {"role": row["role_name"], "state": row["state"]}
        )
    waiting = {row["node"]: row["waiting"] for row in pending}

    return {
        "servers": [
            {
                **machine,
                "roles": by_node.get(machine["fqdn"].lower(), []),
                **agents.describe(contact.get(machine["distinguished_name"].lower())),
                "pending_tasks": waiting.get(machine["fqdn"].lower(), 0),
            }
            for machine in machines
            if machine["fqdn"]
        ]
    }


# ------------------------------------------------------- one machine's state --


@router.get("/computer", dependencies=[Depends(requires("server.read"))])
async def computer_detail(
    dn: Annotated[str, Query(min_length=3, max_length=1024)],
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Everything the machine has told us about itself."""
    fact = await pool.fetchrow(
        FACTS_BY_DN, dn
    )
    events = await pool.fetch(
        """
        SELECT kind, principal, occurred_at, detail
        FROM computer_event WHERE lower(computer_dn) = lower($1)
        ORDER BY occurred_at DESC LIMIT 200
        """,
        dn,
    )
    queued = await pool.fetch(
        """
        SELECT id, kind, state, output, created_at, finished_at
        FROM node_task
        WHERE lower(node_fqdn) = lower(COALESCE($1, ''))
        ORDER BY created_at DESC LIMIT 20
        """,
        fact["hostname"] if fact else None,
    )

    # What this machine's agent is, and what this console would give it. The
    # version a machine is on decides which remote jobs work at all, so it
    # belongs beside the machine rather than in a report somewhere else.
    installed = await pool.fetchval(
        """
        SELECT agent_version FROM agent_report
        WHERE lower(computer_dn) = lower($1) AND agent_version <> ''
        ORDER BY reported_at DESC LIMIT 1
        """,
        dn,
    )
    offer = await run_in_threadpool(agentupdate.available, settings.agent_binary)

    return {
        "known": fact is not None,
        "agent": {
            "installed": installed or "",
            "available": offer.version if offer else "",
            "behind": bool(offer and agentupdate.newer(offer.version, installed or "")),
        },
        "facts": None
        if fact is None
        else {
            "hostname": fact["hostname"],
            "operating_system": fact["operating_system"],
            "kernel": fact["kernel"],
            "booted_at": fact["booted_at"],
            "local_users": json.loads(fact["local_users"]),
            "sessions": json.loads(fact["sessions"]),
            "pending_updates": fact["pending_updates"],
            "security_updates": fact["security_updates"],
            "updates": json.loads(fact["updates"]),
            "updates_checked_at": fact["updates_checked_at"],
            "packages": json.loads(fact["packages"]),
            "package_count": fact["package_count"],
            "reported_at": fact["reported_at"],
        },
        "events": [
            {
                "kind": row["kind"],
                "principal": row["principal"],
                "occurred_at": row["occurred_at"],
                "detail": row["detail"],
            }
            for row in events
        ],
        "tasks": [
            {
                "id": str(row["id"]),
                "kind": row["kind"],
                "state": row["state"],
                "output": row["output"],
                "created_at": row["created_at"],
                "finished_at": row["finished_at"],
            }
            for row in queued
        ],
    }


# Debian package names, as the archive defines them. A value from here reaches
# apt on a machine running as root, so it is checked before it is queued.
PACKAGE_RE = re.compile(r"^[a-z0-9][a-z0-9+.-]{1,127}$")

# Restarting a machine is not the same right as reading what is on it.
POWER_ACTIONS = {"restart", "shutdown"}


class LocalUser(BaseModel):
    """A local account on one machine. Not a directory object."""

    # Debian's own rule for a login name; the agent checks it again as root.
    name: Annotated[str, Field(pattern=r"^[a-z_][a-z0-9_-]{0,31}$")]
    full_name: Annotated[str, Field(default="", max_length=128)] = ""
    shell: Annotated[str, Field(default="/bin/bash", pattern=r"^/[A-Za-z0-9._/-]{1,127}$")] = (
        "/bin/bash"
    )
    groups: Annotated[
        list[Annotated[str, Field(pattern=r"^[a-z_][a-z0-9_-]{0,31}$")]],
        Field(default_factory=list, max_length=16),
    ]
    # Empty means the account is created with password login locked, which is
    # what a service account wants. Never stored, never logged.
    password: Annotated[str, Field(default="", max_length=256)] = ""


class ComputerAction(BaseModel):
    dn: Annotated[str, Field(min_length=3, max_length=1024)]
    action: Annotated[
        str,
        Field(
            pattern="^(update-check|update-install|package-install|package-remove"
            "|local-user-add|local-user-remove|policy-refresh|restart|shutdown"
            "|agent-update)$"
        ),
    ]
    package: Annotated[str, Field(max_length=128)] | None = None
    # For agent-update: empty takes whatever this console has, which is what
    # the button means. A version pins it, and a machine already on it does
    # nothing rather than reinstalling the same file.
    version: Annotated[str, Field(default="", max_length=32, pattern=r"^(\d+\.\d+\.\d+)?$")] = ""
    # A local account, for the two local-user actions. Directory accounts are
    # objects in the directory and are not created from here.
    local_user: LocalUser | None = None


@router.post("/computer/action", status_code=202,
             dependencies=[Depends(requires("computer.manage"))])
async def run_action(
    body: ComputerAction,
    request: Request,
    authz: Authz = Depends(authorization),
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Ask a machine to do something now, rather than at its next refresh."""
    if body.action in POWER_ACTIONS:
        authz.require("computer.power", body.dn)

    payload: dict[str, Any] = {}
    if body.action in ("package-install", "package-remove"):
        if not body.package or not PACKAGE_RE.match(body.package):
            raise objects.ObjectError("that is not a package name")
        payload["package"] = body.package
    if body.action in ("local-user-add", "local-user-remove"):
        if body.local_user is None:
            raise objects.ObjectError("no local account was given")
        payload = body.local_user.model_dump(exclude_none=True)
    if body.action == "agent-update":
        payload["version"] = body.version

    async with pool.acquire() as conn:
        fact = await conn.fetchrow(
            HOSTNAME_BY_DN, body.dn
        )
        if fact is None:
            raise objects.NotFound(
                "this machine has not reported yet, so there is nowhere to send the request"
            )
        task_id = await tasks.enqueue(
            conn,
            node_fqdn=fact["hostname"],
            kind=body.action,
            payload=payload,
            subject=body.dn,
            requested_by=session.principal,
        )
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action=f"computer.{body.action.replace('-', '.')}",
            outcome="success",
            object_type="computer",
            object_dn=body.dn,
            detail=" ".join(
                filter(
                    None,
                    [
                        f"queued for {fact['hostname']}",
                        body.package,
                        # The name, never the password.
                        body.local_user.name if body.local_user else None,
                    ],
                )
            ),
        )
    return {"task": task_id, "node": fact["hostname"]}


@router.get("/computer/browse", dependencies=[Depends(requires("computer.manage"))])
async def browse_computer(
    node: Annotated[str, Query(min_length=1, max_length=253)],
    path: Annotated[str, Query(max_length=1024, pattern=r"^(/[^\x00]*)?$")] = "/",
    make: Annotated[bool, Query()] = False,
    files: Annotated[bool, Query()] = False,
    authz: Authz = Depends(authorization),
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """List what is under a path on one machine.

    Directories only by default, which is what choosing a location needs; with
    files, which is what reading a machine's disk needs. Names, sizes and
    times cross the wire, never contents, and the caller needs the same right
    as any other change to that machine.
    """
    # Named by host name here, because that is what the share dialog has. The
    # right is still checked against the machine's own object.
    row = await pool.fetchrow(
        "SELECT computer_dn, hostname FROM computer_fact WHERE lower(hostname) = lower($1)", node
    )
    if row is None:
        raise objects.NotFound(
            f"{node} has not reported to the console yet, so there is nothing to browse"
        )
    authz.require("computer.manage", row["computer_dn"])
    try:
        answer = await tasks.run_now(
            pool,
            node_fqdn=row["hostname"],
            kind="make-directory" if make else "browse",
            payload={"path": path or "/", "files": files},
            requested_by=session.principal,
        )
    except tasks.TaskFailed as exc:
        raise objects.ObjectError(str(exc)) from exc
    try:
        return json.loads(answer)
    except ValueError as exc:
        raise objects.ObjectError(f"{row['hostname']} sent something unreadable back") from exc


class Permissions(BaseModel):
    node: Annotated[str, Field(min_length=1, max_length=253)]
    path: Annotated[str, Field(min_length=2, max_length=1024, pattern=r"^/[^\x00]*$")]
    # Empty leaves that half alone, which is how "change the group and not the
    # owner" is said. A name here reaches chown as root on the machine, so the
    # shape is checked on both sides.
    owner: Annotated[str, Field(default="", max_length=128, pattern=r"^[A-Za-z0-9._$@ -]*$")] = ""
    group: Annotated[str, Field(default="", max_length=128, pattern=r"^[A-Za-z0-9._$@ -]*$")] = ""
    mode: Annotated[str, Field(default="", max_length=4, pattern=r"^(0?[0-7]{3})?$")] = ""
    recursive: bool = False


@router.post("/computer/permissions", dependencies=[Depends(requires("computer.manage"))])
async def set_permissions(
    body: Permissions,
    request: Request,
    authz: Authz = Depends(authorization),
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Change who a file or folder on a machine belongs to.

    The point of browsing a machine's files from here is to find the one whose
    rights are wrong. Being told to open a terminal to fix it makes the
    browsing pointless, and the console is already root on that machine by
    every other route — so this adds no power, only a way to use one.
    """
    row = await pool.fetchrow(
        "SELECT computer_dn, hostname FROM computer_fact WHERE lower(hostname) = lower($1)",
        body.node,
    )
    if row is None:
        raise objects.NotFound(f"{body.node} has not reported to the console yet")
    authz.require("computer.manage", row["computer_dn"])
    if not (body.owner or body.group or body.mode):
        raise objects.ObjectError("nothing to change")

    try:
        answer = await tasks.run_now(
            pool,
            node_fqdn=row["hostname"],
            kind="set-permissions",
            payload={
                "path": body.path,
                "owner": body.owner,
                "group": body.group,
                "mode": body.mode,
                "recursive": body.recursive,
            },
            requested_by=session.principal,
            timeout=300,
        )
    except tasks.TaskFailed as exc:
        raise objects.ObjectError(str(exc)) from exc

    async with pool.acquire() as conn:
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="computer.permissions",
            outcome="success",
            object_type="computer",
            object_dn=row["computer_dn"],
            detail=f"{row['hostname']}:{body.path}",
            after={
                "owner": body.owner,
                "group": body.group,
                "mode": body.mode,
                "recursive": body.recursive,
            },
        )
    try:
        return json.loads(answer)
    except ValueError as exc:
        raise objects.ObjectError(f"{row['hostname']} sent something unreadable back") from exc


class ShellCommand(BaseModel):
    dn: Annotated[str, Field(min_length=3, max_length=1024)]
    # One command line, run by the machine's own shell. Not validated into a
    # shape here beyond a length: there is no subset of shell that is safe and
    # every subset that is useful is the whole thing. What guards this is the
    # right to call it and the record of who did.
    command: Annotated[str, Field(min_length=1, max_length=4096)]
    timeout_seconds: Annotated[int, Field(default=60, ge=1, le=600)] = 60
    # Where the last command left off. Carried by the console rather than kept
    # on the machine: each command is its own process, and a working directory
    # remembered on one side of a restart and not the other is worse than none.
    cwd: Annotated[str, Field(default="/", max_length=1024, pattern=r"^/[^\x00]*$")] = "/"


def _shell_answer(text: str) -> tuple[str, str, str]:
    """Split what the agent sent into output, working directory and reason.

    The agent answers with one line of JSON; a failed command adds its reason
    after it. An agent too old to know about the working directory sends plain
    text, which is still the output — the console then keeps the directory it
    had, which is what it did before there was one.
    """
    head, _, rest = (text or "").partition("\n")
    try:
        answer = json.loads(head)
    except ValueError:
        return text or "", "", ""
    if not isinstance(answer, dict):
        return text or "", "", ""
    return str(answer.get("output", "")), str(answer.get("cwd", "")), rest.strip()


@router.post("/computer/shell", dependencies=[Depends(requires("computer.shell"))])
async def run_shell(
    body: ShellCommand,
    request: Request,
    authz: Authz = Depends(authorization),
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Run one command on a machine and hand back what it printed.

    This is root on that machine. It is deliberately not dressed up as
    anything smaller: the point of a remote shell is that an operator can do
    what they would have done sitting at the console, and pretending otherwise
    would only mean they sign in to the machine instead and nothing is
    recorded at all.

    So what makes it safe to have is what surrounds it — its own right, the
    same scope check as any other change to that machine, and a record of the
    command, who ran it, from where, and what came back, written whether it
    succeeded or not.
    """
    authz.require("computer.shell", body.dn)
    fact = await pool.fetchrow(HOSTNAME_BY_DN, body.dn)
    if fact is None:
        raise objects.NotFound(
            "this machine has not reported yet, so there is nowhere to send the command"
        )

    output, cwd, failed = "", body.cwd, ""
    try:
        answer = await tasks.run_now(
            pool,
            node_fqdn=fact["hostname"],
            kind="shell-run",
            payload={
                "command": body.command,
                "timeout_seconds": body.timeout_seconds,
                "cwd": body.cwd,
            },
            requested_by=session.principal,
            timeout=body.timeout_seconds + 30,
        )
        output, ended, _ = _shell_answer(answer)
        cwd = ended or body.cwd
    except tasks.TaskFailed as exc:
        # A command that exits non-zero still printed something, and that is
        # usually the answer. The output and the directory it ended in are
        # kept; the reason is what the console shows beside them.
        output, ended, reason = _shell_answer(str(exc))
        cwd = ended or body.cwd
        failed = reason or str(exc)

    async with pool.acquire() as conn:
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="computer.shell",
            outcome="failure" if failed else "success",
            object_type="computer",
            object_dn=body.dn,
            detail=f"{fact['hostname']}: {body.command}",
            after={"output": (output or failed)[-8000:], "cwd": cwd, "failed": failed},
        )
    return {
        "node": fact["hostname"],
        "output": output,
        "cwd": cwd,
        # Not an error status: a non-zero exit is an ordinary answer at a
        # prompt, and losing the output with it would make the shell useless
        # for exactly the commands somebody runs to find out what is wrong.
        "failed": failed,
    }


@router.get("/computer/localadmin",
            dependencies=[Depends(requires("computer.localadmin.read"))])
async def local_administrator(
    request: Request,
    dn: Annotated[str, Query(min_length=3, max_length=1024)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """The machine's own local administrator password.

    Its own permission rather than something that comes with reading a
    computer, and audited on every read: this is the credential that opens the
    machine when the domain cannot be reached, so who looked at it and when is
    part of what it is for.
    """
    row = await pool.fetchrow(
        "SELECT * FROM local_administrator WHERE lower(computer_dn) = lower($1)", dn
    )
    async with pool.acquire() as conn:
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="computer.localadmin.read",
            outcome="success" if row else "failure",
            object_type="computer",
            object_dn=dn,
            detail=None if row else "no password has been reported for this machine",
        )
    if row is None:
        return {"configured": False}
    return {
        "configured": True,
        "account": row["account"],
        "password": row["password"],
        "rotated_at": row["rotated_at"],
        "expires_at": row["expires_at"],
    }


@router.get("/computer/logs", dependencies=[Depends(requires("server.read"))])
async def computer_logs(
    dn: Annotated[str, Query(min_length=3, max_length=1024)],
    hours: Annotated[int, Query(ge=1, le=336)] = 24,
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """A machine's recent journal, grouped by the unit that produced it.

    Grouped here rather than in the console: the counts are what decide which
    groups are worth opening, and computing them once beside the rows keeps the
    page from having to hold everything to work them out.
    """
    rows = await pool.fetch(
        """
        SELECT unit, priority, message, occurred_at
        FROM computer_log
        WHERE lower(computer_dn) = lower($1)
          AND occurred_at > now() - ($2 || ' hours')::interval
        ORDER BY occurred_at DESC
        LIMIT 2000
        """,
        dn,
        str(hours),
    )

    groups: dict[str, dict[str, Any]] = {}
    for row in rows:
        unit = row["unit"] or "system"
        group = groups.setdefault(unit, {"unit": unit, "errors": 0, "entries": []})
        # journalctl's priorities: 3 and below are errors, 4 is a warning.
        if row["priority"] <= 3:
            group["errors"] += 1
        group["entries"].append(
            {
                "priority": row["priority"],
                "message": row["message"],
                "occurred_at": row["occurred_at"],
            }
        )

    # Units with errors first, then by how much they had to say.
    ordered = sorted(
        groups.values(), key=lambda group: (-group["errors"], -len(group["entries"]))
    )
    for group in ordered:
        group["count"] = len(group["entries"])
    return {"hours": hours, "groups": ordered, "total": len(rows)}


class BulkAction(BaseModel):
    """The same request, asked of several machines at once."""

    dns: Annotated[
        list[Annotated[str, Field(max_length=1024)]], Field(min_length=1, max_length=500)
    ]
    action: Annotated[
        str,
        Field(
            pattern="^(update-check|update-install|package-install|package-remove"
            "|policy-refresh|restart|shutdown)$"
        ),
    ]
    package: Annotated[str, Field(max_length=128)] | None = None


@router.post("/computers/action", status_code=202,
             dependencies=[Depends(requires("computer.manage"))])
async def run_bulk_action(
    body: BulkAction,
    request: Request,
    authz: Authz = Depends(authorization),
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Ask the same thing of many machines.

    Each machine is authorised on its own, so a scope that reaches some of a
    selection and not the rest does the part it may and reports the rest —
    rather than refusing everything or, worse, doing everything.
    """
    if body.action in POWER_ACTIONS:
        # Checked per machine below as well; this is the fast refusal for
        # somebody who holds the right nowhere.
        authz.require("computer.power", None)

    payload: dict[str, Any] = {}
    if body.action in ("package-install", "package-remove"):
        if not body.package or not PACKAGE_RE.match(body.package):
            raise objects.ObjectError("that is not a package name")
        payload["package"] = body.package

    queued: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []

    async with pool.acquire() as conn:
        for dn in dict.fromkeys(body.dns):
            try:
                authz.require("computer.manage", dn)
                if body.action in POWER_ACTIONS:
                    authz.require("computer.power", dn)
            except Exception:  # noqa: BLE001 - reported per machine, not fatal
                skipped.append({"dn": dn, "reason": "not permitted here"})
                continue

            fact = await conn.fetchrow(
                HOSTNAME_BY_DN, dn
            )
            if fact is None:
                skipped.append({"dn": dn, "reason": "has not reported yet"})
                continue

            task_id = await tasks.enqueue(
                conn,
                node_fqdn=fact["hostname"],
                kind=body.action,
                payload=payload,
                subject=dn,
                requested_by=session.principal,
            )
            queued.append({"dn": dn, "node": fact["hostname"], "task": task_id})

        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action=f"computer.bulk.{body.action.replace('-', '.')}",
            outcome="success",
            object_type="computer",
            object_dn=f"{len(queued)} machines",
            after={
                "queued": [entry["node"] for entry in queued],
                "skipped": skipped,
                "package": body.package,
            },
        )

    return {"queued": queued, "skipped": skipped}
