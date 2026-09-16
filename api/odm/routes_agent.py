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
import contextlib
import json
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from . import (
    agentupdate,
    audit,
    ca,
    monitor,
    objects,
    push,
    routes_dc,
    rsop,
    sites,
    tasks,
    terminal,
    totp,
)
from . import (
    assist as assisting,
)
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
    return await machine_from_header(request.headers.get("authorization", ""), settings)


async def require_machine_socket(
    websocket: WebSocket,
    settings: Settings = Depends(get_settings),
) -> Machine:
    """require_machine for a WebSocket: the same ticket, on the handshake."""
    return await machine_from_header(websocket.headers.get("authorization", ""), settings)


async def machine_from_header(header: str, settings: Settings) -> Machine:
    if settings.keytab is None:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "no service keytab configured")

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
    # What this console would hand out if asked. Told to every machine on
    # every poll rather than only to the ones being updated: an agent that
    # knows what is available can say so in its report, which is what makes
    # the fleet's versions visible without asking each machine in turn.
    offer = await run_in_threadpool(agentupdate.available, settings.agent_binary)
    if offer is not None:
        document["agent_available"] = {
            "version": offer.version,
            "sha256": offer.sha256,
            "size": offer.size,
        }
    return document


@router.get("/second-factor")
async def agent_second_factor(
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """The second-factor enrolments this machine may hold.

    One line per account in the format pam_oath reads, so the module on the
    machine can ask for a code and check it without the machine ever talking
    to the console at the moment somebody signs in — which is the moment the
    console may be the thing that is unreachable.

    Only the accounts the machine's own policy names. A machine is given the
    secrets of the people who sign in to it and nobody else's, and it is
    given none at all unless a policy object linked to it turns the second
    factor on.
    """
    async with _bound(settings, write=False) as conn:
        document = await rsop.build(pool, settings, conn, machine.dn)
        factor = (document.get("settings") or {}).get("second_factor") or {}
        if not factor.get("enabled"):
            # Not an error: a machine that asks and is told nothing writes an
            # empty file, which is what "nobody here has one" looks like.
            return {"users": []}
        wanted = await run_in_threadpool(
            totp.entitled_principals,
            conn,
            settings,
            require=factor.get("require_principals") or [],
            exempt=factor.get("exempt_principals") or [],
        )

    rows = await pool.fetch(
        "SELECT principal, secret FROM totp_enrolment WHERE confirmed_at IS NOT NULL"
    )
    # Who has a phone enrolled, by name only — no topic, no token. The
    # machine needs to know they count as enrolled (so the grace period and
    # the enrolment walkthrough leave them alone) and nothing else.
    phones = await pool.fetch(
        "SELECT principal FROM push_enrolment WHERE confirmed_at IS NOT NULL"
    )
    push_users = sorted(
        account
        for account in (
            str(row["principal"]).split("@")[0].split("\\")[-1].lower() for row in phones
        )
        if wanted is None or account in wanted
    )
    return {"users": totp.oath_users(rows, wanted), "push_users": push_users}


class MachineEnrolRequest(BaseModel):
    username: Annotated[str, Field(min_length=1, max_length=256)]
    code: Annotated[str, Field(default="", max_length=32)] = ""


async def _may_enrol(
    machine: Machine, pool: asyncpg.Pool, settings: Settings, username: str
) -> dict[str, Any]:
    """Whether this machine may set a second factor up for this person.

    Three things have to hold, and all three are decided here rather than on
    the machine: a policy object linked to that machine asks for a second
    factor and for people to be able to set one up themselves; the account is
    one that policy covers; and the account exists in the directory. A member
    server is not trusted to answer any of them.
    """
    account = username.split("@")[0].split("\\")[-1]
    async with _bound(settings, write=False) as conn:
        document = await rsop.build(pool, settings, conn, machine.dn)
        factor = (document.get("settings") or {}).get("second_factor") or {}
        if not factor.get("enabled") or not factor.get("self_enrol", True):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "no policy on this machine asks people to set up a second factor",
            )
        wanted = await run_in_threadpool(
            totp.entitled_principals,
            conn,
            settings,
            require=factor.get("require_principals") or [],
            exempt=factor.get("exempt_principals") or [],
        )
        if wanted is not None and account.lower() not in wanted:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, f"{account} is not covered by that policy"
            )
        try:
            user = await run_in_threadpool(objects.find_user, conn, settings, account)
        except objects.NotFound as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"no account named {account}") from exc

    sid = str(user.get("objectSid") or "")
    if not sid:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "that account has no identifier")
    return {"sid": sid, "principal": account, "factor": factor}


@router.post("/second-factor/enrol")
async def agent_begin_second_factor(
    body: MachineEnrolRequest,
    request: Request,
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """A secret for somebody setting a second factor up at the machine.

    The person is at a machine they have just authenticated to, being asked
    for something they do not yet have. Sending them to the console instead
    would mean an administrator's tool and a support ticket for what every
    other service does in thirty seconds.

    Calling this twice hands back the same unconfirmed secret rather than a
    new one, so somebody who scanned the code and then closed the window can
    carry on where they stopped. An account that already has a confirmed
    second factor is told so and given nothing.
    """
    who = await _may_enrol(machine, pool, settings, body.username)

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT secret, confirmed_at FROM totp_enrolment WHERE principal_sid = $1",
            who["sid"],
        )
        if row is not None and row["confirmed_at"]:
            return {"already_enrolled": True}
        secret = row["secret"] if row is not None else totp.generate_secret()
        await conn.execute(
            """
            INSERT INTO totp_enrolment (principal_sid, principal, secret, enrolled_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (principal_sid) DO UPDATE
                SET secret = excluded.secret, updated_at = now()
            """,
            who["sid"],
            who["principal"],
            secret,
            f"self, at {machine.hostname}",
        )
    return {
        "already_enrolled": False,
        "secret": secret,
        "uri": totp.provisioning_uri(secret, who["principal"], settings.domain),
        "digits": totp.DIGITS,
        "period": totp.PERIOD,
    }


@router.post("/second-factor/confirm")
async def agent_confirm_second_factor(
    body: MachineEnrolRequest,
    request: Request,
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Finish it, by proving the device actually has the secret."""
    who = await _may_enrol(machine, pool, settings, body.username)

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM totp_enrolment WHERE principal_sid = $1", who["sid"]
        )
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "nothing to confirm")
        if row["confirmed_at"]:
            return {"recovery_codes": []}
        try:
            step = totp.verify(row["secret"], body.code, last_step=row["last_step"])
        except totp.TotpError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

        codes = totp.generate_recovery_codes()
        await conn.execute(
            """
            UPDATE totp_enrolment
            SET confirmed_at = now(), last_step = $2, recovery_codes = $3, updated_at = now()
            WHERE principal_sid = $1
            """,
            who["sid"],
            step,
            codes,
        )
        await audit.record(
            conn,
            actor=who["principal"],
            actor_sid=who["sid"],
            source_ip=request.client.host if request.client else None,
            action="auth.second_factor.enrol",
            outcome="success",
            object_type="session",
            object_dn=machine.dn,
            detail=f"enrolled at {machine.hostname}",
        )
    return {"recovery_codes": codes}


# ------------------------------------------------------- phone approvals ----
# The machine asks; the phone answers; the machine polls for the answer. The
# machine never learns the topic, the token, or anything about the phone —
# only "approved" or not, for a question it asked itself.
#
# Setting the phone up is the one exception, and it is the same shape as
# setting a code up at the machine: the person is at a machine they have just
# authenticated to, being walked through it, and the topic has to reach them
# somehow. It is shown once, on that screen, exactly as a code's secret is.


class PushEnrolRequest(BaseModel):
    username: Annotated[str, Field(min_length=1, max_length=256)]
    # begin: issue (or re-show) an unconfirmed topic and send the phone its
    # Confirm button. poll: say whether the phone has tapped it yet.
    # resend: send the button again to the same topic.
    action: Annotated[str, Field(pattern="^(begin|poll|resend)$")] = "begin"


@router.post("/second-factor/push/enrol")
async def agent_enrol_push(
    body: PushEnrolRequest,
    request: Request,
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Set a phone up for somebody, at the machine.

    Refused unless a policy on this machine uses phone approval and lets
    people set up their own second factor; then the same rules as a code —
    the account is one the policy covers and exists in the directory.
    """
    who = await _may_enrol(machine, pool, settings, body.username)
    factor = who["factor"]
    if factor.get("method") != "push":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "no policy on this machine uses phone approval"
        )
    if not push.configured(settings):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "phone approvals are not set up on this domain"
        )
    external = str(factor.get("push_server_url") or "")

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT topic, confirm_token, confirmed_at FROM push_enrolment "
            "WHERE principal_sid = $1",
            who["sid"],
        )
        if row is not None and row["confirmed_at"]:
            return {"already_enrolled": True, "confirmed": True}
        if body.action == "poll":
            source = request.client.host if request.client else None
            done = await push.settle_enrolment(conn, settings, who["sid"], source)
            return {"already_enrolled": False, "confirmed": done}

        # begin re-uses an unconfirmed topic so a person who scanned it and
        # then lost the window carries on where they stopped; a new one is
        # only issued when there is none.
        topic = row["topic"] if row is not None else push.new_topic()
        token = push.new_token()
        if row is not None and row["confirm_token"]:
            token = row["confirm_token"]
        await conn.execute(
            """
            INSERT INTO push_enrolment (principal_sid, principal, topic, confirm_token)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (principal_sid) DO UPDATE
                SET topic = excluded.topic, confirm_token = excluded.confirm_token,
                    updated_at = now()
            """,
            who["sid"],
            who["principal"],
            topic,
            token,
        )
        try:
            await run_in_threadpool(
                push.ask_to_confirm_phone, settings, topic, token, who["principal"], external
            )
        except push.PushError as exc:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
        if body.action == "begin":
            await audit.record(
                conn,
                actor=who["principal"],
                actor_sid=who["sid"],
                source_ip=request.client.host if request.client else None,
                action="auth.second_factor.push.begin",
                outcome="success",
                object_type="session",
                object_dn=machine.dn,
                detail=f"began setting up a phone at {machine.hostname}",
            )
    return {
        "already_enrolled": False,
        "confirmed": False,
        "server_url": push.server_url(settings, external),
        "subscribe_url": push.subscribe_url(settings, topic, external),
        "topic": topic,
        "trust": await run_in_threadpool(push.phone_trust, settings, external),
        "trust_url": push.trust_url(settings),
        "fingerprint": await run_in_threadpool(push.certificate_fingerprint, settings),
    }


class PushBeginRequest(BaseModel):
    username: Annotated[str, Field(min_length=1, max_length=256)]
    service: Annotated[str, Field(pattern="^(login|ssh|sudo|remote-desktop)$")] = "login"


@router.post("/second-factor/push")
async def agent_begin_push(
    body: PushBeginRequest,
    request: Request,
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Ask the person's phone whether this sign-in is theirs.

    Refused, with a reason the machine can act on, when the policy on this
    machine does not use the push method, when phone approvals are not set
    up on this deployment, or when this person has no phone enrolled — in
    every one of those cases the machine falls back to asking for a code,
    and this is what tells it to.
    """
    account = body.username.split("@")[0].split("\\")[-1]
    async with _bound(settings, write=False) as conn:
        document = await rsop.build(pool, settings, conn, machine.dn)
        factor = (document.get("settings") or {}).get("second_factor") or {}
        if not factor.get("enabled") or factor.get("method") != "push":
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "no policy on this machine uses phone approval"
            )
        if body.service not in (factor.get("services") or []):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, f"the policy does not ask for it on {body.service}"
            )
        try:
            user = await run_in_threadpool(objects.find_user, conn, settings, account)
        except objects.NotFound as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"no account named {account}") from exc
    sid = str(user.get("objectSid") or "")
    if not push.configured(settings):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "phone approvals are not set up on this domain"
        )

    async with pool.acquire() as conn:
        enrolment = await conn.fetchrow(
            "SELECT topic FROM push_enrolment "
            "WHERE principal_sid = $1 AND confirmed_at IS NOT NULL",
            sid,
        )
        if enrolment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"{account} has no phone enrolled")
        token = push.new_token()
        # Answered or not, a question is of no further use a day later; the
        # audit log is the record, not this table.
        await conn.execute(
            "DELETE FROM push_challenge WHERE expires_at < now() - interval '1 day'"
        )
        challenge_id = await conn.fetchval(
            """
            INSERT INTO push_challenge
                (token, principal_sid, principal, machine_dn, hostname, service, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
            """,
            token,
            sid,
            account,
            machine.dn,
            machine.hostname,
            body.service,
            push.expiry(settings),
        )
        # Sent from inside the transaction's view but after the row exists:
        # an answer that arrives before the row would have nothing to land on.
        try:
            await run_in_threadpool(
                push.ask_to_sign_in,
                settings,
                enrolment["topic"],
                token,
                account,
                machine.hostname,
                body.service,
                str(factor.get("push_server_url") or ""),
            )
        except push.PushError as exc:
            await conn.execute("DELETE FROM push_challenge WHERE id = $1", challenge_id)
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
        await audit.record(
            conn,
            actor=account,
            actor_sid=sid,
            source_ip=request.client.host if request.client else None,
            action="auth.second_factor.push.ask",
            outcome="success",
            object_type="session",
            object_dn=machine.dn,
            detail=f"asked the phone about a {body.service} sign-in at {machine.hostname}",
        )
    return {"id": str(challenge_id), "timeout_seconds": settings.push_timeout_seconds}


@router.get("/second-factor/push/{challenge_id}")
async def agent_poll_push(
    challenge_id: str,
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """The answer so far: pending, approved, denied or expired.

    Only for a question this machine asked. A machine cannot learn how some
    other machine's sign-in was answered, let alone reuse it.
    """
    async with pool.acquire() as conn:
        owner = await conn.fetchval(
            "SELECT machine_dn FROM push_challenge WHERE id = $1::uuid", challenge_id
        )
        if owner != machine.dn:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such sign-in")
        decision = await push.settle_challenge(conn, settings, challenge_id)
    return {"decision": decision}


@router.get("/binary")
async def agent_binary(
    machine: Machine = Depends(require_machine),
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    """The agent binary, for a machine updating itself.

    Authenticated as the machine, over the channel it already verified. The
    console is not asked to prove anything more than it proves for policy —
    if a machine can be lied to about its policy it can already be told to run
    a script, so the binary is not a new trust boundary, only a bigger file.
    """
    offer = await run_in_threadpool(agentupdate.available, settings.agent_binary)
    if offer is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "this console has no agent binary to hand out",
        )
    return FileResponse(
        offer.path,
        media_type="application/octet-stream",
        filename=f"odm-agent-{offer.version}",
        headers={"X-ODM-Agent-Version": offer.version, "X-ODM-Agent-Sha256": offer.sha256},
    )


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
    # Set when the report is about one person's session rather than the
    # machine: their drive maps, connection files and background are applied
    # when they sign in, and what happened has to be visible somewhere.
    username: Annotated[str, Field(default="", max_length=104)] = ""
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
                                  applied_gpos, results, failures, username)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, nullif($8, ''))
        """,
        machine.dn,
        machine.hostname,
        body.agent_version,
        body.policy_serial,
        json.dumps(body.applied_gpos),
        json.dumps(results),
        sum(1 for result in results if result["status"] == "failed"),
        body.username,
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
    # What the agent reads from the machine's journal (agent/internal/inventory/
    # activity.go) and from wtmp. Shaped rather than listed: the agent that
    # reads the journal is what knows the kinds, and a newer one must not be
    # refused by an older console; the shape is what keeps the table clean.
    kind: Annotated[str, Field(pattern="^[a-z][a-z0-9-]{1,39}$")]
    principal: Annotated[str, Field(max_length=64)] = ""
    occurred_at: datetime
    detail: Annotated[str, Field(max_length=500)] | None = None
    service: Annotated[str, Field(max_length=32)] = ""
    source: Annotated[str, Field(max_length=64)] = ""


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


class ReportedHardware(BaseModel):
    """The machine itself, as its firmware describes it."""

    vendor: Annotated[str, Field(default="", max_length=128)] = ""
    model: Annotated[str, Field(default="", max_length=128)] = ""
    serial: Annotated[str, Field(default="", max_length=128)] = ""
    chassis: Annotated[str, Field(default="", max_length=32)] = ""
    bios_version: Annotated[str, Field(default="", max_length=64)] = ""
    bios_date: Annotated[str, Field(default="", max_length=32)] = ""
    cpu: Annotated[str, Field(default="", max_length=128)] = ""
    cores: Annotated[int, Field(default=0, ge=0, le=4096)] = 0
    memory_mb: Annotated[int, Field(default=0, ge=0)] = 0


class ReportedDisk(BaseModel):
    """One drive, as SMART reports it."""

    device: Annotated[str, Field(default="", max_length=128)] = ""
    model: Annotated[str, Field(default="", max_length=128)] = ""
    serial: Annotated[str, Field(default="", max_length=128)] = ""
    size_gb: Annotated[int, Field(default=0, ge=0)] = 0
    health: Annotated[str, Field(default="", max_length=16)] = ""
    power_on_hours: Annotated[int, Field(default=0, ge=0)] = 0
    temperature_c: Annotated[int, Field(default=0, ge=-100, le=200)] = 0
    reallocated_sectors: Annotated[int, Field(default=0, ge=0)] = 0
    percentage_used: Annotated[int, Field(default=0, ge=0, le=1000)] = 0


class ReportedVolume(BaseModel):
    """One block device, and what the machine says about its encryption."""

    device: Annotated[str, Field(max_length=128)]
    format: Annotated[str, Field(default="", max_length=32)] = ""
    holder: Annotated[str, Field(default="", max_length=128)] = ""
    mount_point: Annotated[str, Field(default="", max_length=512)] = ""
    size_bytes: Annotated[int, Field(default=0, ge=0)] = 0
    encrypted: bool = False
    at_boot: bool = False
    free_key_slots: Annotated[int, Field(default=0, ge=0, le=64)] = 0


class Inventory(BaseModel):
    """What a machine says about itself.

    Every list here may arrive as null: an empty slice in Go marshals that
    way, and a field the agent had nothing for used to take the whole report
    down with it — one 422, and the console showed nothing at all about that
    machine.
    """

    @model_validator(mode="before")
    @classmethod
    def _null_lists_are_empty(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        for name, field in cls.model_fields.items():
            key = field.alias or name
            if data.get(key, "") is None and "list" in str(field.annotation):
                data[key] = []
        return data

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
    # `samba-tool drs showrepl` as this machine ran it, on a controller; empty
    # from anything else. Parsed rather than trusted: it is one machine's
    # account of its own replication, which is exactly whose account it should
    # be, and the console only reads it for controllers.
    replication: Annotated[str, Field(max_length=32768)] = ""
    # Which of this machine's disks are encrypted.
    volumes: Annotated[list[ReportedVolume], Field(default_factory=list, max_length=64)]
    # What the machine is, and what its drives say about their own health.
    hardware: ReportedHardware = ReportedHardware()
    disks: Annotated[list[ReportedDisk], Field(default_factory=list, max_length=32)]
    # The agent's own version, on every check-in rather than only the ones
    # where a policy apply also ran — an agent that replaced itself between
    # two unchanged polls otherwise never says so.
    agent_version: Annotated[str, Field(max_length=32)] = ""


# Where install-agent.sh puts the role installers, on this machine as on every
# other. The console hands out its own copies so a machine joined at 0.8.1 does
# not keep installing roles the way 0.8.1 did: the agent updates itself from
# here, and until now the scripts beside it never moved.
ROLE_DIR = Path("/usr/lib/odm/roles")


@router.get("/role-script")
async def agent_role_script(
    role: Annotated[str, Query(min_length=2, max_length=32, pattern=r"^[a-z][a-z0-9-]{1,31}$")],
    _: Machine = Depends(require_machine),
) -> dict[str, str]:
    """The installer for one role, and the helpers it sources, as this console
    has them.

    A machine runs the installer; the console decides which one. Nothing here
    is a secret — the same scripts are in the source tree — but it is only
    served to a machine in this domain, like everything else the agent asks
    for.
    """
    installer = ROLE_DIR / f"install-{role}-role.sh"
    common = ROLE_DIR / "odm-role-common.sh"
    if not installer.is_file():
        raise objects.NotFound(f"this console has no installer for {role}")
    answer = {"installer": installer.read_text(encoding="utf-8", errors="strict")}
    if common.is_file():
        answer["common"] = common.read_text(encoding="utf-8", errors="strict")
    return answer


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
                addresses, site_name, print_devices, replication,
                replication_at, volumes, hardware, disks, agent_version, reported_at
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb,
                    CASE WHEN $11 THEN now() ELSE NULL END, $12::jsonb, $13,
                    $14::jsonb, $15, $16::jsonb, nullif($17, ''),
                    CASE WHEN $17 <> '' THEN now() ELSE NULL END, $18::jsonb,
                    $19::jsonb, $20::jsonb, $21, now())
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
                -- A machine that reports none keeps what it last reported:
                -- an agent restarted mid-collection must not blank the
                -- replication panel.
                replication        = COALESCE(excluded.replication,
                                              computer_fact.replication),
                replication_at     = COALESCE(excluded.replication_at,
                                              computer_fact.replication_at),
                volumes            = excluded.volumes,
                hardware           = excluded.hardware,
                disks              = excluded.disks,
                -- Likewise: an agent too old to send this at all must not
                -- blank a version a newer one already reported.
                agent_version      = CASE WHEN excluded.agent_version <> ''
                                          THEN excluded.agent_version
                                          ELSE computer_fact.agent_version END,
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
            body.replication,
            json.dumps([volume.model_dump() for volume in body.volumes]),
            json.dumps(body.hardware.model_dump()),
            json.dumps([disk.model_dump() for disk in body.disks]),
            body.agent_version,
        )

        # A local administrator the machine no longer has — the policy stopped
        # naming one and the agent removed the account, or somebody deleted it
        # by hand — must not go on being shown with a password that opens
        # nothing. The machine's own account list is the truth about that.
        present = {user.name for user in body.local_users}
        stale = await conn.fetchval(
            "SELECT account FROM local_administrator WHERE lower(computer_dn) = lower($1)",
            machine.dn,
        )
        if stale and stale not in present:
            await conn.execute(
                "DELETE FROM local_administrator WHERE lower(computer_dn) = lower($1)", machine.dn
            )
            await audit.record(
                conn,
                actor=machine.hostname or machine.sam_account_name,
                action="computer.localadmin.gone",
                outcome="success",
                object_type="computer",
                object_dn=machine.dn,
                detail=f"{stale} is no longer on the machine; its password was discarded",
            )

        # The same machine under the name it used to have. Moving a machine to
        # another organizational unit changes its distinguished name, and the
        # row it wrote under the old one stayed behind for ever — one machine
        # as two, and a lookup by host name free to pick the stale one.
        if machine.hostname:
            await conn.execute(
                """
                DELETE FROM computer_fact
                WHERE lower(hostname) = lower($1) AND computer_dn <> $2
                """,
                machine.hostname,
                machine.dn,
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
                    (computer_dn, hostname, kind, principal, occurred_at, detail,
                     service, source)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (computer_dn, kind, principal, occurred_at) DO NOTHING
                """,
                machine.dn,
                machine.hostname,
                event.kind,
                event.principal,
                event.occurred_at,
                event.detail,
                event.service,
                event.source,
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


@router.websocket("/shell/{session_id}")
async def agent_shell(
    websocket: WebSocket,
    session_id: str,
    machine: Machine = Depends(require_machine_socket),
) -> None:
    """The machine's end of a terminal session (see terminal.py).

    The agent connects here when told to by a shell-session task, with its
    own Kerberos ticket on the handshake. The session must have been asked
    for on this machine: a machine cannot attach to a terminal meant for
    another, whatever it knows.
    """
    pool: asyncpg.Pool = websocket.app.state.pool
    opened = terminal.registry.get(session_id)
    if opened is None or opened.closed.is_set() or opened.dn.lower() != machine.dn.lower():
        await websocket.close(code=4404)
        return
    await websocket.accept()
    opened.agent_joined.set()

    async def from_agent() -> None:
        while True:
            message = await websocket.receive_bytes()
            if message and message[0] == terminal.FRAME_DATA:
                opened.note_output(message[1:])
            elif (frame := terminal.parse_control(message)) and frame.get("type") == "exit":
                status_code = frame.get("status")
                opened.exit_status = status_code if isinstance(status_code, int) else None
                await opened.to_console.put(message)
                opened.close("the shell exited")
                return
            await opened.to_console.put(message)

    async def to_agent() -> None:
        while True:
            message = await opened.to_agent.get()
            if message is None:
                return
            await websocket.send_bytes(message)

    reader = asyncio.create_task(from_agent())
    writer = asyncio.create_task(to_agent())
    try:
        await asyncio.wait({reader, writer}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        opened.close("the machine went away")
        for task in (reader, writer):
            task.cancel()
            with contextlib.suppress(BaseException):
                await task
        await terminal.finish(pool, opened)
        with contextlib.suppress(Exception):
            await websocket.close()


@router.websocket("/assist/{session_id}")
async def agent_assist(
    websocket: WebSocket,
    session_id: str,
    machine: Machine = Depends(require_machine_socket),
) -> None:
    """The machine's end of a shared screen (see assist.py).

    The agent connects here once the person has agreed and the VNC server is
    up on the machine's loopback, and waits. The first message it gets is the
    word "open", which means a viewer has attached and it should connect to
    the server; every frame after that, both ways, is VNC bytes. When the
    viewer goes the connection is closed, and the agent comes back for the
    next one until the offer runs out.
    """
    offer = assisting.registry.get(session_id)
    if offer is None or offer.dn.lower() != machine.dn.lower():
        await websocket.close(code=4404)
        return
    await websocket.accept()
    link = assisting.Link()
    offer.offer_link(link)

    async def from_agent() -> None:
        while True:
            message = await websocket.receive_bytes()
            await link.to_console.put(message)

    async def to_agent() -> None:
        while True:
            message = await link.to_agent.get()
            if message is None:
                return
            if isinstance(message, str):
                await websocket.send_text(message)
            else:
                await websocket.send_bytes(message)

    async def until_over() -> None:
        await offer.ended.wait()

    reader = asyncio.create_task(from_agent())
    writer = asyncio.create_task(to_agent())
    over = asyncio.create_task(until_over())
    try:
        await asyncio.wait({reader, writer, over}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        link.close()
        if offer.link is link:
            offer.link = None
        for task in (reader, writer, over):
            task.cancel()
            with contextlib.suppress(BaseException):
                await task
        with contextlib.suppress(Exception):
            # 4410: the offer is over, do not come back.
            await websocket.close(code=4410 if offer.expired else 1000)


# ------------------------------------------------------------- monitoring --


class MetricSample(BaseModel):
    metric: Annotated[str, Field(max_length=128)]
    value: float
    # A probe reports about its target, not about the machine that ran it.
    host: Annotated[str, Field(max_length=253)] = ""


class MetricsReport(BaseModel):
    samples: Annotated[list[MetricSample], Field(max_length=500)]


@router.post("/metrics", status_code=204)
async def agent_metrics(
    body: MetricsReport,
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    """What the machine measured about itself, and about what it probed.

    Refused when no monitoring role exists: nothing would read the numbers,
    and a table nobody reads should not be written.
    """
    if not await monitor.active(pool):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no monitoring role is installed")
    rows = []
    for sample in body.samples:
        if not monitor.METRIC_RE.match(sample.metric):
            continue
        host = machine.hostname.lower()
        if sample.metric.startswith("probe_"):
            if not sample.host or not monitor.HOST_RE.match(sample.host):
                continue
            host = sample.host.lower()
        elif sample.host:
            # A machine may only report about itself.
            continue
        if sample.value != sample.value:  # NaN
            continue
        rows.append((host, sample.metric, float(sample.value)))
    if not rows:
        return
    async with pool.acquire() as conn:
        await conn.executemany(
            "INSERT INTO metric_sample (host, metric, value) VALUES ($1, $2, $3)", rows
        )
