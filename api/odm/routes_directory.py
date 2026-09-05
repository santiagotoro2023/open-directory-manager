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

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Annotated, Any, Literal

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from . import audit, db, directory, dynamicgroups, objects, policy_schema
from .authz import Denied
from .config import Settings, get_settings
from .security import Authz, authorization, client_ip, get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/directory", tags=["directory"])

# Delegation is per object type: a helpdesk role that may reset passwords is
# not thereby allowed to rewrite an organizational unit.
_log = logging.getLogger("odm.directory")

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


@router.get("/membership")
async def read_membership(
    dn: str = Query(max_length=1024),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """What this object is a member of, and what is a member of it.

    Both directions for every kind of object. A group belongs to groups the
    same way a user does, and it is nesting that makes a rule about one group
    reach an account nobody put in it — so the groups reached through another
    group are listed next to the direct ones rather than left to be worked out
    from five separate pages.
    """
    authz.require("directory.read", dn)
    found = await _read(settings, objects.membership, dn)
    # A group's kind decides its icon and label everywhere else in the console;
    # a membership table is no different.
    for key in ("member_of", "members"):
        found[key] = await _with_kinds(pool, found[key])
    return found


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


class PhotoRequest(BaseModel):
    dn: Dn
    # Base64, or empty to clear it. thumbnailPhoto is defined in the Active
    # Directory schema with an upper bound of 100 kB, so a picture over it is
    # refused by the directory itself — with a message about a constraint
    # rather than about a picture. It is measured decoded, here, where the
    # limit can be said in the terms somebody chose the file in.
    photo: Annotated[str, Field(max_length=200_000)] = ""

    @field_validator("photo")
    @classmethod
    def _within_the_schema(cls, value: str) -> str:
        if len(value) * 3 // 4 > 100_000:
            raise ValueError(
                "the picture must be under 100 kB; the console stores one at 256×256"
            )
        return value


@router.post("/user/photo", status_code=204)
async def set_photo(
    body: PhotoRequest,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> None:
    """Set the picture every machine shows for this person."""
    authz.require("user.write", body.dn)
    photo = policy_schema.validate_image(body.photo) if body.photo else ""
    async with _audit_context(
        request, session, pool, "user.photo", object_type="user", object_dn=body.dn
    ) as entry:
        async with _bound(settings, write=True) as conn:
            await run_in_threadpool(objects.set_photo, conn, settings, body.dn, photo)
        # The picture itself is not written to the audit log; that it changed is.
        entry.after = {"photo": "set" if photo else "cleared"}


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
                INSERT INTO deleted_object (object_dn, object_type, object_guid, object_sid,
                                            display_name, parent_dn,
                                            attributes, memberships, members, deleted_by,
                                            purge_after)
                VALUES ($1, $2, $3::uuid, $4, $5, $6,
                        $7::jsonb, $8::jsonb, $9::jsonb, $10, now() + $11::interval)
                """,
                state["object_dn"],
                state["object_type"],
                # The identity the directory keeps on its tombstone. Without
                # the GUID there is nothing to reanimate and every restore
                # created a new object with a new SID — which is not a
                # restore, whatever the console said.
                objects.object_guid(state["attributes"]),
                (state["attributes"] or {}).get("objectSid"),
                state["display_name"],
                state["parent_dn"],
                db.dumps(state["attributes"]),
                db.dumps(state["memberships"]),
                db.dumps(state["members"]),
                session.principal,
                timedelta(days=settings.retention_days),
            )


# ---------------------------------------------------------------- in bulk ---


class BulkRequest(BaseModel):
    """One change, applied to a selection of objects.

    Creating from CSV has always been possible; changing objects that already
    exist has not, and doing it one at a time is what makes a department move
    or a title change an afternoon's work.
    """

    dns: Annotated[list[Dn], Field(min_length=1, max_length=500)]
    # Attributes to set on every one of them. An empty value clears it, as it
    # does on a single object.
    changes: Annotated[
        dict[str, Annotated[str | None, Field(max_length=1024)]], Field(default_factory=dict)
    ]
    add_groups: Annotated[list[Dn], Field(default_factory=list, max_length=32)]
    remove_groups: Annotated[list[Dn], Field(default_factory=list, max_length=32)]
    move_to: Dn | None = None
    # Whether to enable or disable each account. Left unset, neither.
    enabled: bool | None = None


@router.post("/objects/bulk")
async def bulk_change(
    body: BulkRequest,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Apply one change to every object named.

    Each object is its own success or failure. One that cannot be changed —
    protected, gone, outside the caller's scope — is reported by name and the
    rest still happen, because stopping at the first failure in a run of five
    hundred leaves nobody able to say what did and did not.
    """
    for group in body.add_groups + body.remove_groups:
        authz.require("group.member.write", group)
    if body.move_to is not None:
        authz.require("object.move", body.move_to)

    changed: list[str] = []
    problems: list[dict[str, str]] = []

    async with _bound(settings, write=True) as conn:
        for dn in body.dns:
            try:
                before = await run_in_threadpool(objects.get, conn, settings, dn)
                authz.require(WRITE_PERMISSION.get(before.get("objectType"), "*"), dn)
                current = dn
                if body.changes:
                    await run_in_threadpool(
                        objects.update, conn, settings, current, body.changes
                    )
                if body.enabled is not None:
                    await run_in_threadpool(
                        objects.set_enabled, conn, settings, current, enabled=body.enabled
                    )
                for group in body.add_groups:
                    await run_in_threadpool(
                        objects.edit_members, conn, settings, group, add=[current], remove=[]
                    )
                for group in body.remove_groups:
                    await run_in_threadpool(
                        objects.edit_members, conn, settings, group, add=[], remove=[current]
                    )
                if body.move_to is not None:
                    authz.require("object.move", current)
                    current = await run_in_threadpool(
                        objects.move, conn, settings, current, body.move_to, None
                    )
                changed.append(current)
            except (
                objects.ObjectError,
                objects.NotFound,
                objects.ProtectedObject,
                Denied,
            ) as exc:
                problems.append({"dn": dn, "reason": str(exc)})

    async with pool.acquire() as conn:
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="object.bulk",
            outcome="success" if not problems else "partial",
            object_type="directory",
            detail=f"{len(changed)} changed, {len(problems)} refused",
            after={
                "changes": body.changes,
                "add_groups": body.add_groups,
                "remove_groups": body.remove_groups,
                "move_to": body.move_to,
                "enabled": body.enabled,
                "changed": changed[:200],
                "problems": problems[:200],
            },
        )
    return {"changed": changed, "problems": problems}


# --------------------------------------------------------- dynamic groups ---


class GroupQueryRequest(BaseModel):
    group_dn: Dn
    scope_dn: Annotated[str, Field(default="", max_length=1024)] = ""
    object_type: Literal["user", "computer"] = "user"
    conditions: Annotated[
        list[dict[str, Annotated[str, Field(max_length=256)]]],
        Field(default_factory=list, max_length=16),
    ]
    match_all: bool = True
    enabled: bool = True


@router.get("/groups/queries", dependencies=[Depends(requires("directory.read"))])
async def list_group_queries(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Every group whose membership is a query, and how the last run went."""
    rows = await pool.fetch("SELECT * FROM group_query ORDER BY group_dn")
    return {
        "queries": [_query_json(row) for row in rows],
        "attributes": [
            {"key": key, "label": label} for key, label in dynamicgroups.ATTRIBUTES.items()
        ],
        "operators": list(dynamicgroups.OPERATORS),
    }


def _query_json(row: asyncpg.Record) -> dict[str, Any]:
    conditions = json.loads(row["conditions"])
    return {
        "group_dn": row["group_dn"],
        "scope_dn": row["scope_dn"],
        "object_type": row["object_type"],
        "conditions": conditions,
        "match_all": row["match_all"],
        "enabled": row["enabled"],
        "summary": dynamicgroups.describe(conditions, row["match_all"]),
        "member_count": row["member_count"],
        "last_run_at": row["last_run_at"],
        "last_error": row["last_error"],
    }


@router.put("/groups/query", dependencies=[Depends(requires("group.query.write"))])
async def save_group_query(
    body: GroupQueryRequest,
    request: Request,
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Make a group's membership a question, and answer it now.

    Run immediately rather than at the next tick: an operator who has just
    written a query wants to see who it matches while they can still correct
    it.
    """
    authz.require("group.member.write", body.group_dn)
    try:
        conditions = dynamicgroups.validate(list(body.conditions))
    except dynamicgroups.QueryError as exc:
        raise objects.ObjectError(str(exc)) from exc

    async with _bound(settings, write=False) as conn:
        group = await run_in_threadpool(objects.get, conn, settings, body.group_dn)
    if group.get("objectType") != "group":
        raise objects.ObjectError("only a group's membership can be a query")

    async with _audit_context(
        request, session, pool, "group.query.write",
        object_type="group", object_dn=body.group_dn,
    ) as entry:
        row = await pool.fetchrow(
            """
            INSERT INTO group_query (group_dn, scope_dn, object_type, conditions,
                                     match_all, enabled, created_by)
            VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
            ON CONFLICT (group_dn) DO UPDATE SET
                scope_dn = excluded.scope_dn,
                object_type = excluded.object_type,
                conditions = excluded.conditions,
                match_all = excluded.match_all,
                enabled = excluded.enabled,
                updated_at = now()
            RETURNING *
            """,
            body.group_dn,
            body.scope_dn,
            body.object_type,
            json.dumps(conditions),
            body.match_all,
            body.enabled,
            session.principal,
        )
        entry.after = _query_json(row)

    result = await run_group_query(pool, settings, body.group_dn)
    return {**_query_json(row), **result}


@router.delete("/groups/query", status_code=204,
               dependencies=[Depends(requires("group.query.write"))])
async def delete_group_query(
    request: Request,
    group_dn: Annotated[str, Query(min_length=3, max_length=1024)],
    session: Session = Depends(require_admin),
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    """Stop maintaining a group's membership. Who is in it now stays in it."""
    authz.require("group.member.write", group_dn)
    async with _audit_context(
        request, session, pool, "group.query.delete",
        object_type="group", object_dn=group_dn,
    ):
        await pool.execute("DELETE FROM group_query WHERE group_dn = $1", group_dn)


async def run_group_query(
    pool: asyncpg.Pool, settings: Settings, group_dn: str
) -> dict[str, Any]:
    """Make one group's membership match its query.

    The query is the membership, not an addition to it: somebody put in the
    group by hand is taken out again at the next run. That is what "a group
    whose membership is a query" means, and the alternative — two sources of
    truth for one list — is how a group ends up with members nobody can
    explain.
    """
    row = await pool.fetchrow("SELECT * FROM group_query WHERE group_dn = $1", group_dn)
    if row is None or not row["enabled"]:
        return {"added": 0, "removed": 0}

    conditions = json.loads(row["conditions"])
    try:
        ldap_filter = dynamicgroups.build_filter(
            row["object_type"], conditions, row["match_all"]
        )
        async with _bound(settings, write=True) as conn:
            found = await run_in_threadpool(
                objects.search_filter,
                conn,
                settings,
                ldap_filter,
                row["scope_dn"] or None,
            )
            group = await run_in_threadpool(objects.get, conn, settings, group_dn)
            current = [str(dn) for dn in group.get("member") or []]
            add, remove = dynamicgroups.membership_change(current, found)
            if add or remove:
                await run_in_threadpool(
                    objects.edit_members, conn, settings, group_dn, add=add, remove=remove
                )
    except (
        dynamicgroups.QueryError,
        objects.ObjectError,
        objects.NotFound,
        directory.DirectoryError,
    ) as exc:
        await pool.execute(
            "UPDATE group_query SET last_run_at = now(), last_error = $2 WHERE group_dn = $1",
            group_dn,
            str(exc),
        )
        return {"added": 0, "removed": 0, "error": str(exc)}

    await pool.execute(
        """
        UPDATE group_query
        SET last_run_at = now(), last_error = NULL, member_count = $2
        WHERE group_dn = $1
        """,
        group_dn,
        len(found),
    )
    return {"added": len(add), "removed": len(remove), "member_count": len(found)}


async def group_query_loop(pool: asyncpg.Pool, settings: Settings) -> None:
    """Keep every dynamic group's membership true, on a quarter-hour tick.

    The same interval an agent polls on, because that is how long a change in
    the directory already takes to reach a machine: a membership that lags by
    less than that changes nothing anybody can see.
    """
    while True:
        await asyncio.sleep(15 * 60)
        try:
            rows = await pool.fetch(
                "SELECT group_dn FROM group_query WHERE enabled ORDER BY group_dn"
            )
            for row in rows:
                await run_group_query(pool, settings, row["group_dn"])
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a loop that dies stops maintaining every group
            _log.exception("running the group queries")
