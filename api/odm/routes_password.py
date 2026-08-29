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
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import audit, directory, objects, rsop
from .config import Settings, get_settings
from .dns import SAMBA_TOOL, DnsUnavailable, available
from .routes_directory import _bound, _write
from .security import client_ip, get_pool, require_admin, requires_domain_admin
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
            document = await rsop.build(pool, settings, conn, session.distinguished_name)
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
                object_dn=session.distinguished_name,
                detail="the current password was wrong",
            )
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "the current password is not correct"
        ) from exc

    await _write(
        settings, objects.set_password, session.distinguished_name, body.new_password, False
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
            object_dn=session.distinguished_name,
            detail="changed by the account itself",
        )
