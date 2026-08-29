"""Password policy, and changing your own password.

Two different things share this module because they answer the same question
from opposite ends: what a password has to be, and who may set one.

The policy itself lives in the directory, not in ODM's database. Samba
enforces it on every password change however it is made — through this
console, through a client, or through samba-tool — and a second copy here
would be a rule that looks authoritative and is not.
"""

from __future__ import annotations

import re
import subprocess
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import audit, directory, objects, password_policy, rsop
from .config import Settings, get_settings
from .dns import SAMBA_TOOL, DnsUnavailable, available
from .routes_directory import _bound, _read, _write
from .security import client_ip, get_pool, require_admin, requires, requires_domain_admin
from .sessions import Session

router = APIRouter(prefix="/api/v1/password", tags=["password"])

TIMEOUT_SECONDS = 30

_SETTING_RE = re.compile(r"^\s*([A-Za-z ()]+?)\s*:\s*(.+?)\s*$")

# What samba-tool calls each setting, and what an operator calls it.
FIELDS: dict[str, str] = {
    "min_pwd_length": "--min-pwd-length",
    "min_pwd_age": "--min-pwd-age",
    "max_pwd_age": "--max-pwd-age",
    "history_length": "--history-length",
    "account_lockout_threshold": "--account-lockout-threshold",
    "account_lockout_duration": "--account-lockout-duration",
    "reset_account_lockout_after": "--reset-account-lockout-after",
}


class PolicyUpdate(BaseModel):
    complexity: Annotated[str, Field(pattern="^(on|off)$")] | None = None
    min_pwd_length: Annotated[int, Field(ge=0, le=255)] | None = None
    min_pwd_age: Annotated[int, Field(ge=0, le=999)] | None = None
    max_pwd_age: Annotated[int, Field(ge=0, le=999)] | None = None
    history_length: Annotated[int, Field(ge=0, le=24)] | None = None
    account_lockout_threshold: Annotated[int, Field(ge=0, le=999)] | None = None
    account_lockout_duration: Annotated[int, Field(ge=0, le=99999)] | None = None
    reset_account_lockout_after: Annotated[int, Field(ge=0, le=99999)] | None = None


class ChangeRequest(BaseModel):
    """Changing your own password. The current one is always required."""

    current_password: Annotated[str, Field(min_length=1, max_length=256)]
    new_password: Annotated[str, Field(min_length=1, max_length=256)]


def _run(*args: str) -> str:
    if not available():
        raise DnsUnavailable(
            "samba-tool is not installed on the API host; password policy "
            "management requires the control plane to run on a domain controller"
        )
    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, validated arguments
        [SAMBA_TOOL, "domain", "passwordsettings", *args],
        capture_output=True,
        text=True,
        timeout=TIMEOUT_SECONDS,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip().splitlines()
        raise objects.ObjectError(detail[-1] if detail else "samba-tool refused the change")
    return completed.stdout


def read_policy() -> dict[str, Any]:
    """The domain's password policy, as the directory holds it."""
    settings: dict[str, Any] = {}
    for line in _run("show").splitlines():
        match = _SETTING_RE.match(line)
        if not match:
            continue
        label, value = match.group(1).strip(), match.group(2).strip()
        settings[label] = value
    return settings


@router.get("/policy")
async def policy(
    _: Session = Depends(require_admin),
) -> dict[str, Any]:
    """What a password in this domain has to be."""
    return {"policy": await run_in_threadpool(read_policy)}


@router.patch("/policy", dependencies=[Depends(requires_domain_admin())])
async def update_policy(
    body: PolicyUpdate,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Change the domain's password policy.

    Applied through samba-tool so the directory is the only place the rule
    lives, and so it is enforced identically however a password is changed.
    """
    before = await run_in_threadpool(read_policy)

    arguments: list[str] = []
    if body.complexity is not None:
        arguments += ["--complexity", body.complexity]
    for field, flag in FIELDS.items():
        value = getattr(body, field)
        if value is not None:
            arguments += [flag, str(value)]
    if not arguments:
        raise objects.ObjectError("nothing to change")

    await run_in_threadpool(_run, "set", *arguments)
    after = await run_in_threadpool(read_policy)

    async with pool.acquire() as conn:
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="password.policy.update",
            outcome="success",
            object_type="domain",
            object_dn="password-policy",
            before=before,
            after=after,
        )
    return {"policy": after}


@router.get("/self-service")
async def self_service_state(
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Whether this account may change its own password here.

    Decided by policy resolved for the account, so it can be allowed for one
    part of the domain and not another, like anything else.
    """
    try:
        async with _bound(settings, write=False) as conn:
            document = await rsop.build(pool, settings, conn, session.principal_dn)
    except Exception:  # noqa: BLE001 - a policy that cannot be read is not an allow
        return {"enabled": False, "detail": "the effective policy could not be read"}

    setting = (document.get("settings") or {}).get("password_self_service")
    if setting is None:
        # No policy says anything. Changing your own password is ordinary, so
        # the default is yes; a policy object is how it is taken away.
        return {"enabled": True, "minimum_length": 12}
    return {
        "enabled": bool(setting.get("enabled", True)),
        "minimum_length": int(setting.get("minimum_length", 12)),
    }


@router.post("/change", status_code=204)
async def change_own_password(
    body: ChangeRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
):
    """Change the signed-in account's own password.

    The current password is verified by binding as the account with it. That
    is the whole check: a session alone is not enough to change a password,
    because a session can be a machine somebody walked away from.
    """
    state = await self_service_state(session=session, pool=pool, settings=settings)
    if not state["enabled"]:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "changing your own password is not allowed for this account",
        )
    if len(body.new_password) < state["minimum_length"]:
        raise objects.ObjectError(
            f"the new password must be at least {state['minimum_length']} characters"
        )
    if body.new_password == body.current_password:
        raise objects.ObjectError("the new password is the same as the current one")

    try:
        await run_in_threadpool(
            directory.authenticate, settings, session.principal, body.current_password
        )
    except directory.InvalidCredentials as exc:
        async with pool.acquire() as conn:
            await audit.record(
                conn,
                actor=session.principal,
                actor_sid=session.principal_sid,
                source_ip=client_ip(request),
                action="password.change",
                outcome="denied",
                object_type="user",
                object_dn=session.principal_dn,
                detail="the current password was wrong",
            )
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "the current password is not correct"
        ) from exc

    await _write(
        settings, objects.set_password, session.principal_dn, body.new_password, False
    )
    async with pool.acquire() as conn:
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="password.change",
            outcome="success",
            object_type="user",
            object_dn=session.principal_dn,
            detail="changed by the account itself",
        )


# ------------------------------------------------------ fine-grained policy --
# A password policy that reaches some accounts and not others.
#
# AD applies these to users and groups, never to a container. An organizational
# unit is therefore resolved to the users beneath it and each applied
# individually, and re-resolved on every save and on the sweep — so somebody
# created afterwards is picked up rather than quietly missed.


class PolicyObject(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=63)]
    description: Annotated[str, Field(max_length=255)] = ""
    precedence: Annotated[int, Field(ge=1, le=10000)] = 100
    complexity: bool = True
    min_length: Annotated[int, Field(ge=1, le=255)] = 12
    history: Annotated[int, Field(ge=0, le=24)] = 5
    min_age_days: Annotated[int, Field(ge=0, le=999)] = 0
    max_age_days: Annotated[int, Field(ge=0, le=999)] = 0
    lockout_threshold: Annotated[int, Field(ge=0, le=999)] = 0
    lockout_minutes: Annotated[int, Field(ge=0, le=99999)] = 30
    group_dns: list[Annotated[str, Field(max_length=1024)]] = Field(default_factory=list)
    container_dns: list[Annotated[str, Field(max_length=1024)]] = Field(default_factory=list)


def _definition(body: PolicyObject) -> password_policy.Definition:
    return password_policy.Definition(
        name=password_policy.validate_name(body.name),
        precedence=body.precedence,
        complexity=body.complexity,
        min_length=body.min_length,
        history=body.history,
        min_age_days=body.min_age_days,
        max_age_days=body.max_age_days,
        lockout_threshold=body.lockout_threshold,
        lockout_minutes=body.lockout_minutes,
    )


async def resolve_targets(
    settings: Settings, group_dns: list[str], container_dns: list[str]
) -> list[str]:
    """Everything the policy should reach, as distinguished names."""
    targets = [dn.strip() for dn in group_dns if dn.strip()]
    for container in container_dns:
        container = container.strip()
        if not container:
            continue
        found, _ = await _read(
            settings,
            objects.search,
            object_type="user",
            container=container,
            query=None,
            scope="subtree",
            limit=1000,
        )
        targets.extend(entry["distinguishedName"] for entry in found)
    # Order is not meaningful and duplicates would be applied twice.
    return sorted(set(targets))


async def sync_policy(
    pool: asyncpg.Pool, settings: Settings, row: asyncpg.Record
) -> dict[str, Any]:
    """Make the directory match what ODM holds for one policy."""
    definition = password_policy.Definition(
        name=row["name"],
        precedence=row["precedence"],
        complexity=row["complexity"],
        min_length=row["min_length"],
        history=row["history"],
        min_age_days=row["min_age_days"],
        max_age_days=row["max_age_days"],
        lockout_threshold=row["lockout_threshold"],
        lockout_minutes=row["lockout_minutes"],
    )
    try:
        await run_in_threadpool(password_policy.upsert, definition)
        wanted = await resolve_targets(
            settings, list(row["group_dns"]), list(row["container_dns"])
        )
        current = await run_in_threadpool(password_policy.applied_to, row["name"])
        change = password_policy.reconcile(row["name"], wanted, current)
        if change["add"]:
            await run_in_threadpool(password_policy.apply_to, row["name"], change["add"])
        if change["remove"]:
            await run_in_threadpool(password_policy.unapply_from, row["name"], change["remove"])
    except Exception as exc:  # noqa: BLE001 - recorded against the policy, not raised
        await pool.execute(
            "UPDATE password_policy SET state = 'failed', last_error = $2, updated_at = now()"
            " WHERE id = $1",
            row["id"],
            str(exc)[:500],
        )
        return {"state": "failed", "detail": str(exc)}

    await pool.execute(
        """
        UPDATE password_policy
        SET state = 'active', last_error = NULL, applied_to = $2, updated_at = now()
        WHERE id = $1
        """,
        row["id"],
        wanted,
    )
    return {"state": "active", "applied_to": wanted, **change}


@router.get("/policies", dependencies=[Depends(requires("password.policy.write"))])
async def list_policies(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    rows = await pool.fetch("SELECT * FROM password_policy ORDER BY precedence, name")
    return {"policies": [password_policy.as_json(dict(row)) for row in rows]}


@router.post("/policies", status_code=201,
             dependencies=[Depends(requires("password.policy.write"))])
async def create_policy_object(
    body: PolicyObject,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    definition = _definition(body)
    if not body.group_dns and not body.container_dns:
        raise objects.ObjectError(
            "a password policy has to reach somebody: name a group, or an "
            "organizational unit whose users it should cover"
        )

    async with pool.acquire() as conn:
        if await conn.fetchval(
            "SELECT 1 FROM password_policy WHERE lower(name) = lower($1)", definition.name
        ):
            raise objects.ObjectError(f"a policy called {definition.name} already exists")
        row = await conn.fetchrow(
            """
            INSERT INTO password_policy
                (name, description, precedence, complexity, min_length, history,
                 min_age_days, max_age_days, lockout_threshold, lockout_minutes,
                 group_dns, container_dns, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
            """,
            definition.name,
            body.description,
            body.precedence,
            body.complexity,
            body.min_length,
            body.history,
            body.min_age_days,
            body.max_age_days,
            body.lockout_threshold,
            body.lockout_minutes,
            body.group_dns,
            body.container_dns,
            session.principal,
        )
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="password.policy.create",
            outcome="success",
            object_type="password_policy",
            object_dn=definition.name,
            after=password_policy.as_json(dict(row)),
        )

    result = await sync_policy(pool, settings, row)
    fresh = await pool.fetchrow("SELECT * FROM password_policy WHERE id = $1", row["id"])
    return {**password_policy.as_json(dict(fresh)), "sync": result}


@router.post("/policies/sync", dependencies=[Depends(requires("password.policy.write"))])
async def sync_policies(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Re-resolve every policy's organizational units and reapply.

    Run on demand as well as on the sweep, so an operator who has just created
    a batch of users does not have to wait for it.
    """
    rows = await pool.fetch("SELECT * FROM password_policy")
    return {
        "synced": [
            {"name": row["name"], **await sync_policy(pool, settings, row)} for row in rows
        ]
    }


@router.delete("/policies", status_code=204,
               dependencies=[Depends(requires("password.policy.write"))])
async def delete_policy_object(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM password_policy WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such policy")
        try:
            await run_in_threadpool(password_policy.delete, row["name"])
        except password_policy.PasswordPolicyError:
            # Already gone from the directory; removing our record is still right.
            pass
        await conn.execute("DELETE FROM password_policy WHERE id = $1::uuid", id)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="password.policy.delete",
            outcome="success",
            object_type="password_policy",
            object_dn=row["name"],
            before=password_policy.as_json(dict(row)),
        )
