"""Directory management endpoints.

DNs are passed in the query string or the body, never in the path — a DN
contains commas, equals signs and spaces, and path-escaping them is a bug
factory. Every DN is still parsed and proven to be inside the domain head
before it reaches the directory (see objects.normalize_dn).

Every write here is wrapped in audit.audited, so the audit trail is part of
the write path from the first directory endpoint rather than bolted on
later (CLAUDE.md §7.2).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Annotated, Any, Literal

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import audit, db, directory, objects
from .config import Settings, get_settings
from .security import Authz, authorization, client_ip, get_pool, require_admin
from .sessions import Session

router = APIRouter(prefix="/api/v1/directory", tags=["directory"])

# Delegation is per object type: a helpdesk role that may reset passwords is
# not thereby allowed to rewrite an organizational unit.
WRITE_PERMISSION = {
    "user": "user.write",
    "group": "group.write",
    "computer": "computer.write",
    "ou": "ou.write",
}

Name = Annotated[str, Field(min_length=1, max_length=104)]
Dn = Annotated[str, Field(min_length=3, max_length=1024)]
Text = Annotated[str | None, Field(default=None, max_length=1024)]


@asynccontextmanager
async def _bound(settings: Settings, *, write: bool):
    """One GSSAPI-bound connection per request.

    ponytail: binds per request rather than pooling connections. Bind cost is
    a few milliseconds on a LAN; introduce ldap3's connection pool here if
    that ever shows up in a profile.
    """
    conn = await run_in_threadpool(directory.service_connection, settings, read_only=not write)
    try:
        yield conn
    finally:
        await run_in_threadpool(conn.unbind)


async def _read(settings: Settings, fn, *args, **kwargs):
    async with _bound(settings, write=False) as conn:
        return await run_in_threadpool(fn, conn, settings, *args, **kwargs)


async def _write(settings: Settings, fn, *args, **kwargs):
    async with _bound(settings, write=True) as conn:
        return await run_in_threadpool(fn, conn, settings, *args, **kwargs)


def _audit_context(request: Request, session: Session, pool: asyncpg.Pool, action: str, **kwargs):
    return audit.audited(
        pool,
        actor=session.principal,
        actor_sid=session.principal_sid,
        source_ip=client_ip(request),
        action=action,
        **kwargs,
    )


async def _with_kinds(pool: asyncpg.Pool, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Label each group with what it is for.

    A group ODM has never classified reads as a user group, so a group made
    outside the console still has a sensible label.
    """
    sids = [
        str(entry["objectSid"])
        for entry in entries
        if entry.get("objectType") == "group" and entry.get("objectSid")
    ]
    kinds: dict[str, str] = {}
    if sids:
        rows = await pool.fetch(
            "SELECT object_sid, kind FROM group_kind WHERE object_sid = ANY($1::text[])", sids
        )
        kinds = {row["object_sid"]: row["kind"] for row in rows}
    for entry in entries:
        if entry.get("objectType") == "group":
            entry["groupKind"] = kinds.get(str(entry.get("objectSid") or ""), "user")
    return entries


async def _record_kind(
    pool: asyncpg.Pool, entry: dict[str, Any], kind: str, actor: str
) -> None:
    if not entry.get("objectSid"):
        return
    await pool.execute(
        """
        INSERT INTO group_kind (object_sid, kind, group_dn, updated_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (object_sid) DO UPDATE
            SET kind = excluded.kind, group_dn = excluded.group_dn,
                updated_by = excluded.updated_by, updated_at = now()
        """,
        str(entry["objectSid"]),
        kind,
        entry["distinguishedName"],
        actor,
    )


# ------------------------------------------------------------------- reads ---


@router.get("/tree")
async def tree(
    authz: Authz = Depends(authorization),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Every OU and built-in container, plus the domain head."""
    authz.require("directory.read", settings.base_dn)
    nodes = await _read(settings, objects.containers)
    netbios = await _read(settings, directory.netbios_name)
    return {
        "base_dn": settings.base_dn,
        "domain": settings.domain,
        "netbios_name": netbios,
        "nodes": nodes,
    }


@router.get("/objects")
async def list_objects(
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
    object_type: Literal["user", "group", "computer", "ou"] | None = None,
    container: str | None = Query(default=None, max_length=1024),
    query: str | None = Query(default=None, max_length=128),
    scope: Literal["level", "subtree"] = "level",
    limit: int = Query(default=200, ge=1, le=1000),
) -> dict[str, Any]:
    authz.require("directory.read", container or settings.base_dn)
    found, truncated = await _read(
        settings,
        objects.search,
        object_type=object_type,
        container=container,
        query=query,
        scope=scope,
        limit=limit,
    )
    return {"objects": await _with_kinds(pool, found), "truncated": truncated}


@router.get("/object")
async def read_object(
    dn: str = Query(max_length=1024),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    authz.require("directory.read", dn)
    entry = await _read(settings, objects.get, dn)
    return (await _with_kinds(pool, [entry]))[0]


# ----------------------------------------------------------------- creates ---


class CreateUser(BaseModel):
    container: Dn
    sam_account_name: Name
    name: Name | None = None
    user_principal_name: Text = None
    given_name: Text = None
    surname: Text = None
    display_name: Text = None
    mail: Text = None
    description: Text = None
    password: Annotated[str | None, Field(default=None, min_length=1, max_length=256)] = None
    must_change_password: bool = False
    enabled: bool = True


class CreateGroup(BaseModel):
    container: Dn
    name: Name
    # What the group is for; decides which objects the console offers as
    # members and how it is labelled.
    kind: Literal["user", "computer"] = "user"
    # Where it can be used across the forest.
    scope: Literal["global", "domain-local", "universal"] = "global"
    description: Text = None


class GroupKindRequest(BaseModel):
    dn: Dn
    kind: Literal["user", "computer"]


class CreateComputer(BaseModel):
    container: Dn
    name: Name
    dns_host_name: Text = None
    description: Text = None


class CreateOu(BaseModel):
    container: Dn
    name: Annotated[str, Field(min_length=1, max_length=64)]
    description: Text = None


async def _create(request, session, pool, settings, action, object_type, fn, payload) -> dict:
    async with _audit_context(
        request, session, pool, action, object_type=object_type
    ) as entry:
        dn = await _write(settings, fn, payload)
        entry.object_dn = dn
        created = await _read(settings, objects.get, dn)
        entry.after = created
        return created


@router.post("/users", status_code=201)
async def create_user(
    body: CreateUser,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    # Audited state is re-read from the directory, so the password in the
    # request body never reaches the audit log.
    authz.require("user.write", body.container)
    return await _create(
        request,
        session,
        pool,
        settings,
        "user.create",
        "user",
        objects.create_user,
        body.model_dump(),
    )


@router.post("/groups", status_code=201)
async def create_group(
    body: CreateGroup,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    authz.require("group.write", body.container)
    created = await _create(
        request,
        session,
        pool,
        settings,
        "group.create",
        "group",
        objects.create_group,
        body.model_dump(),
    )
    await _record_kind(pool, created, body.kind, session.principal)
    created["groupKind"] = body.kind
    return created


@router.post("/computers", status_code=201)
async def create_computer(
    body: CreateComputer,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    authz.require("computer.write", body.container)
    return await _create(
        request,
        session,
        pool,
        settings,
        "computer.create",
        "computer",
        objects.create_computer,
        body.model_dump(),
    )


@router.post("/ous", status_code=201)
async def create_ou(
    body: CreateOu,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    authz.require("ou.write", body.container)
    return await _create(
        request, session, pool, settings, "ou.create", "ou", objects.create_ou, body.model_dump()
    )


class BulkUsers(BaseModel):
    users: Annotated[list[CreateUser], Field(min_length=1, max_length=500)]


@router.post("/users/bulk")
async def bulk_create_users(
    body: BulkUsers,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Create many users, reporting per-row outcomes.

    One bad row does not abort the import — the operator gets a result per
    row, the same way a CSV import in ADUC behaves.
    """
    for row in body.users:
        authz.require("user.write", row.container)

    results: list[dict[str, Any]] = []
    for row in body.users:
        try:
            created = await _create(
                request,
                session,
                pool,
                settings,
                "user.create",
                "user",
                objects.create_user,
                row.model_dump(),
            )
        except (objects.ObjectError, objects.NotFound, objects.ProtectedObject) as exc:
            results.append(
                {"sam_account_name": row.sam_account_name, "created": False, "error": str(exc)}
            )
        else:
            results.append(
                {
                    "sam_account_name": row.sam_account_name,
                    "created": True,
                    "dn": created["distinguishedName"],
                }
            )
    return {"results": results, "created": sum(1 for r in results if r["created"])}


# ----------------------------------------------------------------- updates ---


class UpdateRequest(BaseModel):
    dn: Dn
    changes: dict[str, Annotated[str | None, Field(max_length=1024)]]


@router.patch("/object")
async def update_object(
    body: UpdateRequest,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with _audit_context(
        request, session, pool, "object.update", object_dn=body.dn
    ) as entry:
        async with _bound(settings, write=True) as conn:
            before = await run_in_threadpool(objects.get, conn, settings, body.dn)
            authz.require(WRITE_PERMISSION.get(before.get("objectType"), "*"), body.dn)
            after = await run_in_threadpool(
                objects.update, conn, settings, body.dn, body.changes
            )
        entry.object_type = before.get("objectType")
        entry.before = before
        entry.after = after
        return after


class MoveRequest(BaseModel):
    dn: Dn
    target_container: Dn
    new_name: Name | None = None


@router.post("/object/move")
async def move_object(
    body: MoveRequest,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    # A move needs the right at both ends, or an operator could shuttle
    # objects out of their own scope.
    authz.require("object.move", body.dn)
    authz.require("object.move", body.target_container)
    async with _audit_context(request, session, pool, "object.move", object_dn=body.dn) as entry:
        async with _bound(settings, write=True) as conn:
            before = await run_in_threadpool(objects.get, conn, settings, body.dn)
            new_dn = await run_in_threadpool(
                objects.move, conn, settings, body.dn, body.target_container, body.new_name
            )
            after = await run_in_threadpool(objects.get, conn, settings, new_dn)
        entry.object_type = before.get("objectType")
        entry.before = {"distinguishedName": before["distinguishedName"]}
        entry.after = {"distinguishedName": new_dn}
        return after


class EnabledRequest(BaseModel):
    dn: Dn
    enabled: bool


@router.post("/object/enabled")
async def set_enabled(
    body: EnabledRequest,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    action = "object.enable" if body.enabled else "object.disable"
    async with _audit_context(request, session, pool, action, object_dn=body.dn) as entry:
        async with _bound(settings, write=True) as conn:
            existing = await run_in_threadpool(objects.get, conn, settings, body.dn)
            authz.require(WRITE_PERMISSION.get(existing.get("objectType"), "*"), body.dn)
            await run_in_threadpool(
                objects.set_enabled, conn, settings, body.dn, enabled=body.enabled
            )
            after = await run_in_threadpool(objects.get, conn, settings, body.dn)
        entry.object_type = after.get("objectType")
        entry.after = {"userAccountControl": after.get("userAccountControl")}
        return after


class PasswordRequest(BaseModel):
    dn: Dn
    password: Annotated[str, Field(min_length=1, max_length=256)]
    must_change: bool = False


@router.post("/user/password", status_code=204)
async def set_password(
    body: PasswordRequest,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
):
    """Reset a password. The password itself is never audited or logged."""
    authz.require("user.password.reset", body.dn)
    async with _audit_context(
        request, session, pool, "user.password.reset", object_type="user", object_dn=body.dn
    ) as entry:
        await _write(settings, objects.set_password, body.dn, body.password, body.must_change)
        entry.detail = "must change at next logon" if body.must_change else None


@router.post("/group/kind")
async def set_group_kind(
    body: GroupKindRequest,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Change whether a group is a user group or a computer group."""
    authz.require("group.write", body.dn)
    async with _audit_context(
        request, session, pool, "group.kind", object_type="group", object_dn=body.dn
    ) as entry:
        group = await _read(settings, objects.get, body.dn)
        if group.get("objectType") != "group":
            raise objects.ObjectError("not a group")
        labelled = (await _with_kinds(pool, [group]))[0]
        entry.before = {"groupKind": labelled.get("groupKind")}
        await _record_kind(pool, group, body.kind, session.principal)
        entry.after = {"groupKind": body.kind}
        return {**group, "groupKind": body.kind}


class MembersRequest(BaseModel):
    dn: Dn
    add: Annotated[list[Dn], Field(default_factory=list, max_length=1000)]
    remove: Annotated[list[Dn], Field(default_factory=list, max_length=1000)]


@router.post("/group/members")
async def edit_members(
    body: MembersRequest,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    authz.require("group.member.write", body.dn)
    async with _audit_context(
        request, session, pool, "group.members.edit", object_type="group", object_dn=body.dn
    ) as entry:
        async with _bound(settings, write=True) as conn:
            before = await run_in_threadpool(objects.get, conn, settings, body.dn)
            after = await run_in_threadpool(
                objects.edit_members, conn, settings, body.dn, add=body.add, remove=body.remove
            )
        entry.before = {"member": before.get("member") or []}
        entry.after = {"member": after.get("member") or []}
        return (await _with_kinds(pool, [after]))[0]


# ----------------------------------------------------------------- deletes ---


@router.delete("/object", status_code=204)
async def delete_object(
    request: Request,
    dn: str = Query(max_length=1024),
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
):
    """Soft delete: snapshot the object into the recycle bin, then remove it.

    The retention store is written before the directory delete, so a failed
    delete never leaves an orphan snapshot and a successful one is always
    restorable (CLAUDE.md §5.3). Restore and purge ship with the recycle-bin
    UI in Phase 7.
    """
    authz.require("object.delete", dn)
    async with _audit_context(request, session, pool, "object.delete", object_dn=dn) as entry:
        state = await _write(settings, objects.delete, dn)
        entry.object_type = state["object_type"]
        entry.object_dn = state["object_dn"]
        entry.before = state["attributes"]

        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO deleted_object (object_dn, object_type, display_name, parent_dn,
                                            attributes, memberships, members, deleted_by,
                                            purge_after)
                VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, now() + $9::interval)
                """,
                state["object_dn"],
                state["object_type"],
                state["display_name"],
                state["parent_dn"],
                db.dumps(state["attributes"]),
                db.dumps(state["memberships"]),
                db.dumps(state["members"]),
                session.principal,
                timedelta(days=settings.retention_days),
            )
