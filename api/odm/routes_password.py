"""Reading the domain's password policy, and changing your own password.

The policy itself is a policy-object setting and is written from there — see
password_policy. It lives in the directory, never in ODM's database: Samba
enforces it on every password change however it is made, through this
console, through a client, or through samba-tool, and a second copy here
would be a rule that looks authoritative and is not.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import audit, directory, objects, password_policy, rsop
from .config import Settings, get_settings
from .routes_directory import _bound, _write
from .security import client_ip, get_pool, require_admin
from .sessions import Session

router = APIRouter(prefix="/api/v1/password", tags=["password"])


class ChangeRequest(BaseModel):
    """Changing your own password. The current one is always required."""

    current_password: Annotated[str, Field(min_length=1, max_length=256)]
    new_password: Annotated[str, Field(min_length=1, max_length=256)]


@router.get("/policy")
async def policy(
    _: Session = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """What a password in this domain has to be, as the directory holds it.

    Read only: it is set from a policy object linked at the domain root, like
    every other setting, and this is what the directory made of it.
    """
    return {"policy": await run_in_threadpool(password_policy.read_domain, settings)}


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
        return {"enabled": True, "minimum_length": 12, **dict.fromkeys(COMPLEXITY, False)}
    return {
        "enabled": bool(setting.get("enabled", True)),
        "minimum_length": int(setting.get("minimum_length", 12)),
        **{rule: bool(setting.get(rule, False)) for rule in COMPLEXITY},
    }


# What a self-service password must contain, when a policy object asks for it.
# The description is what the person is told; the test is what decides.
COMPLEXITY: dict[str, tuple[str, Callable[[str], bool]]] = {
    "require_uppercase": ("an upper-case letter", lambda p: any(c.isupper() for c in p)),
    "require_lowercase": ("a lower-case letter", lambda p: any(c.islower() for c in p)),
    "require_digit": ("a digit", lambda p: any(c.isdigit() for c in p)),
    "require_symbol": (
        "a symbol",
        lambda p: any(not c.isalnum() and not c.isspace() for c in p),
    ),
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
    # Said here rather than left to the directory, so somebody gets the rule
    # they missed instead of one flat refusal from Samba.
    missing = [
        description
        for rule, (description, holds) in COMPLEXITY.items()
        if state.get(rule) and not holds(body.new_password)
    ]
    if missing:
        raise objects.ObjectError("the new password needs " + ", ".join(missing))
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
