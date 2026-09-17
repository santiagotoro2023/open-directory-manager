"""The password-manager role: Vaultwarden, run and managed by ODM.

Nothing about it is done in the vault's own pages. The console owns the
organisation through a service account of its own (vaultkeeper.py), and
what an administrator decides here — who has a seat, which collections
exist, which groups see which — is reconciled into the vault on a timer
and at every Apply. People use the vault: the extension, the app, or the
Vault tab; they never administer it.

The vault is reached at the console's own address, /vault, and the console
carries the traffic to the node (vaultproxy.py); people sign in with their
domain account through the console's OpenID provider (oidc.py).

Setup is one press: the node gets its address and certificate, the
console's account and the organisation are made, and from then on the
seats and collections below are kept in step.
"""

from __future__ import annotations

import json
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from . import audit, ca, directory, objects, oidc, tasks, vaultkeeper, vaultproxy
from .config import Settings, get_settings
from .policy_schema import PRINCIPAL_RE
from .security import client_ip, get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/passwords", tags=["passwords"])


def _plain(value: str) -> str:
    if any(character in value for character in "\n\r\x00\"'"):
        raise ValueError("a value is one line without quotes")
    return value.strip()


class SeatsConfig(BaseModel):
    """Who has a seat: the members of these groups, and these accounts."""

    seat_groups: Annotated[
        list[Annotated[str, Field(max_length=64)]], Field(default_factory=list, max_length=200)
    ]
    seat_users: Annotated[
        list[Annotated[str, Field(max_length=64)]], Field(default_factory=list, max_length=500)
    ]

    @field_validator("seat_groups", "seat_users")
    @classmethod
    def _names(cls, value: list[str]) -> list[str]:
        cleaned = []
        for name in value:
            name = name.strip().lstrip("%")
            if not PRINCIPAL_RE.match(name):
                raise ValueError(f"{name!r} is not an account or group name")
            if name not in cleaned:
                cleaned.append(name)
        return cleaned


class SetupRequest(SeatsConfig):
    """The one press. Optionally the administrator's own domain password,
    used once to give their vault account the same master password."""

    my_password: Annotated[str, Field(max_length=256)] = ""


class CollectionRequest(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return _plain(value)


class AccessRequest(BaseModel):
    group_name: Annotated[str, Field(max_length=64)]
    read_only: bool = False

    @field_validator("group_name")
    @classmethod
    def _group(cls, value: str) -> str:
        value = value.strip().lstrip("%")
        if not PRINCIPAL_RE.match(value):
            raise ValueError(f"{value!r} is not a group name")
        return value


async def _node(pool: asyncpg.Pool) -> str:
    return await vaultproxy.node(pool)


def _json_list(raw: Any) -> list[str]:
    return vaultkeeper._json_list(raw)


async def _collections(pool: asyncpg.Pool) -> list[dict[str, Any]]:
    rows = await pool.fetch(
        """
        SELECT c.id, c.name, c.vault_id, c.updated_at,
               coalesce(json_agg(json_build_object('group_name', a.group_name,
                                                   'read_only', a.read_only)
                                 ORDER BY a.group_name) FILTER (WHERE a.group_name IS NOT NULL),
                        '[]'::json) AS access
        FROM vault_collection c
        LEFT JOIN vault_collection_access a ON a.collection_id = c.id
        GROUP BY c.id ORDER BY c.name
        """
    )
    return [
        {
            "id": str(row["id"]),
            "name": row["name"],
            "in_vault": bool(row["vault_id"]),
            "access": row["access"]
            if isinstance(row["access"], list)
            else json.loads(row["access"]),
        }
        for row in rows
    ]


async def _public(pool: asyncpg.Pool, settings: Settings) -> dict[str, Any]:
    row = await pool.fetchrow("SELECT * FROM password_manager WHERE id = 1")
    node = await _node(pool)
    members = (
        row["members"] if isinstance(row["members"], list) else json.loads(row["members"] or "[]")
    )
    return {
        "installed": bool(node),
        "node_fqdn": node,
        "vault_url": vaultproxy.vault_url(settings),
        "ca_ready": ca.initialised(settings),
        "mail_domain": settings.domain,
        "ready": bool(row["org_id"]),
        "org_name": row["org_name"],
        "owner_account": row["owner_account"],
        "seat_groups": _json_list(row["sync_groups"]),
        "seat_users": _json_list(row["seat_users"]),
        "members": members,
        "collections": await _collections(pool),
        "admin_token_known": bool(row["admin_token"]),
        "last_applied_at": row["last_applied_at"],
        "last_result": row["last_result"],
        "last_sync_at": row["last_sync_at"],
        "last_sync_result": row["last_sync_result"],
        "sync_requested": row["sync_requested"],
        "updated_at": row["updated_at"],
    }


@router.get("", dependencies=[Depends(requires("passwords.read"))])
async def status(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    return await _public(pool, settings)


async def dispatch(
    conn: asyncpg.Connection, settings: Settings, actor: str, *, sync_now: bool = True
) -> str:
    """Send the node its configuration: the certificate, the vault's
    address, sign-in through the console. Also called when
    the role's installation finishes."""
    row = await conn.fetchrow("SELECT * FROM password_manager WHERE id = 1")
    node = await conn.fetchval(
        "SELECT node_fqdn FROM server_role WHERE role_name = 'password-manager'"
        " AND state = 'active' ORDER BY updated_at DESC LIMIT 1"
    )
    if not node:
        raise objects.ObjectError("the password-manager role is not installed anywhere yet")
    vault_url = vaultproxy.vault_url(settings)
    sso_client_id, sso_client_secret = row["sso_client_id"], row["sso_client_secret"]
    redirects = [f"{vault_url}/identity/connect/oidc-signin"]
    if not sso_client_id or not sso_client_secret:
        sso_client_id = "password-manager"
        sso_client_secret = await oidc.register_client(
            conn, sso_client_id, "the password manager", redirects
        )
        await conn.execute(
            "UPDATE password_manager SET sso_client_id = $1, sso_client_secret = $2 WHERE id = 1",
            sso_client_id,
            sso_client_secret,
        )
    else:
        await oidc.update_redirects(conn, sso_client_id, redirects)
    payload = {
        "vault_url": vault_url,
        "server_certificate": ca.initialised(settings),
        "sso_enabled": True,
        "sso_only": True,
        "sso_authority": oidc.issuer(settings),
        "sso_client_id": sso_client_id,
        "sso_client_secret": sso_client_secret,
        "mail_domain": settings.domain,
    }
    task_id = await tasks.enqueue(
        conn,
        node_fqdn=node,
        kind="passwords-apply",
        payload=payload,
        subject="password-manager",
        requested_by=actor,
    )
    await conn.execute(
        "UPDATE password_manager SET node_fqdn = $1, last_applied_at = now(),"
        " last_result = 'applying', sync_requested = $2 WHERE id = 1",
        node,
        sync_now,
    )
    return str(task_id)


async def _reconcile_patiently(pool: asyncpg.Pool, settings: Settings) -> str:
    import asyncio  # noqa: PLC0415

    last = ""
    for attempt in range(12):
        try:
            return await vaultkeeper.reconcile(pool, settings)
        except Exception as exc:  # noqa: BLE001 - reported on the page, retried by the loop
            last = f"not yet: {exc}"
            if attempt < 11:
                await asyncio.sleep(5)
    await pool.execute(
        "UPDATE password_manager SET last_sync_result = $1, sync_requested = true WHERE id = 1",
        last[:500],
    )
    return last


async def _record(
    conn: asyncpg.Connection,
    request: Request,
    session: Session,
    action: str,
    after: dict[str, Any] | None = None,
    detail: str | None = None,
) -> None:
    await audit.record(
        conn,
        actor=session.principal,
        actor_sid=session.principal_sid,
        source_ip=client_ip(request),
        action=action,
        outcome="success",
        object_type="role",
        object_dn="password-manager",
        after=after,
        detail=detail,
    )


@router.post("/setup", dependencies=[Depends(requires("passwords.write"))])
async def setup(
    body: SetupRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Set the vault up, all of it: the seats, the node's configuration,
    the console's account and the organisation. The person pressing gets
    a seat themselves, and — if they gave their domain password — a vault
    account whose master password is that password."""
    if not ca.initialised(settings):
        raise objects.ObjectError("set up the certificate authority first, under Certificates")
    me = session.principal.split("@")[0]
    seat_users = list(body.seat_users)
    if me.lower() not in {u.lower() for u in seat_users}:
        seat_users.append(me)
    if body.my_password:
        # Their own password, checked against the directory before it is
        # used for anything — a typo must not become a master password.
        try:
            await run_in_threadpool(directory.authenticate, settings, me, body.my_password)
        except (directory.InvalidCredentials, directory.NotAuthorized) as exc:
            raise objects.ObjectError("that is not your domain password") from exc
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE password_manager
            SET sync_groups = $1::jsonb, seat_users = $2::jsonb, updated_at = now()
            WHERE id = 1
            """,
            json.dumps(body.seat_groups),
            json.dumps(seat_users),
        )
        task_id = await dispatch(conn, settings, session.principal, sync_now=True)
        await _record(
            conn,
            request,
            session,
            "passwords.setup",
            after={"seat_groups": body.seat_groups, "seat_users": seat_users},
        )
    # The organisation now, rather than at the next timer tick: the page
    # is waiting. The node is applying its configuration at the same
    # moment — and restarting the vault for it — so the first attempts may
    # find nobody listening; they are repeated for a minute before the
    # keeper's own loop is left to finish the job.
    summary = await _reconcile_patiently(pool, settings)
    if body.my_password and summary and not summary.startswith("not yet"):
        try:
            await vaultkeeper.set_master_password(pool, settings, me, body.my_password)
            summary += "; your master password is your domain password"
        except Exception as exc:  # noqa: BLE001 - the seat exists either way
            summary += f"; your master password could not be set: {exc}"
    return {"task": task_id, "summary": summary, **await _public(pool, settings)}


@router.put("/seats", dependencies=[Depends(requires("passwords.write"))])
async def seats(
    body: SeatsConfig,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE password_manager
            SET sync_groups = $1::jsonb, seat_users = $2::jsonb, sync_requested = true,
                updated_at = now()
            WHERE id = 1
            """,
            json.dumps(body.seat_groups),
            json.dumps(body.seat_users),
        )
        await _record(
            conn,
            request,
            session,
            "passwords.seats",
            after={"seat_groups": body.seat_groups, "seat_users": body.seat_users},
        )
    return await _public(pool, settings)


@router.post("/collections", dependencies=[Depends(requires("passwords.write"))])
async def create_collection(
    body: CollectionRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        exists = await conn.fetchval(
            "SELECT 1 FROM vault_collection WHERE lower(name) = lower($1)", body.name
        )
        if exists:
            raise objects.ObjectError(f"a collection called {body.name!r} exists already")
        await conn.execute(
            "INSERT INTO vault_collection (name, created_by) VALUES ($1, $2)",
            body.name,
            session.principal,
        )
        await conn.execute("UPDATE password_manager SET sync_requested = true WHERE id = 1")
        await _record(
            conn, request, session, "passwords.collection.create", after={"name": body.name}
        )
    return await _public(pool, settings)


@router.put("/collections", dependencies=[Depends(requires("passwords.write"))])
async def rename_collection(
    body: CollectionRequest,
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM vault_collection WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such collection")
        await conn.execute(
            "UPDATE vault_collection SET name = $2, updated_at = now() WHERE id = $1::uuid",
            id,
            body.name,
        )
        await conn.execute("UPDATE password_manager SET sync_requested = true WHERE id = 1")
        await _record(
            conn,
            request,
            session,
            "passwords.collection.rename",
            after={"from": row["name"], "to": body.name},
        )
    return await _public(pool, settings)


@router.delete("/collections", dependencies=[Depends(requires("passwords.write"))])
async def delete_collection(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Remove a collection from the console's list; the keeper removes it
    from the vault — with everything in it, which is why the page asks."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM vault_collection WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such collection")
        await conn.execute("DELETE FROM vault_collection WHERE id = $1::uuid", id)
        await conn.execute("UPDATE password_manager SET sync_requested = true WHERE id = 1")
        await _record(
            conn, request, session, "passwords.collection.delete", after={"name": row["name"]}
        )
    return await _public(pool, settings)


@router.put("/collections/access", dependencies=[Depends(requires("passwords.write"))])
async def grant_access(
    body: AccessRequest,
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Give a domain group a collection, or change whether it may edit it."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM vault_collection WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such collection")
        # The group has to exist; the keeper would otherwise fail every pass.
        from .routes_directory import _bound  # noqa: PLC0415

        async with _bound(settings, write=False) as ldap:
            await run_in_threadpool(objects.find_group, ldap, settings, body.group_name)
        await conn.execute(
            """
            INSERT INTO vault_collection_access (collection_id, group_name, read_only)
            VALUES ($1::uuid, $2, $3)
            ON CONFLICT (collection_id, group_name) DO UPDATE SET read_only = EXCLUDED.read_only
            """,
            id,
            body.group_name,
            body.read_only,
        )
        await conn.execute("UPDATE password_manager SET sync_requested = true WHERE id = 1")
        await _record(
            conn,
            request,
            session,
            "passwords.collection.access",
            after={
                "collection": row["name"],
                "group": body.group_name,
                "read_only": body.read_only,
            },
        )
    return await _public(pool, settings)


@router.delete("/collections/access", dependencies=[Depends(requires("passwords.write"))])
async def revoke_access(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    group: Annotated[str, Query(min_length=1, max_length=64)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM vault_collection WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such collection")
        await conn.execute(
            "DELETE FROM vault_collection_access"
            " WHERE collection_id = $1::uuid AND group_name = $2",
            id,
            group.lstrip("%"),
        )
        await conn.execute("UPDATE password_manager SET sync_requested = true WHERE id = 1")
        await _record(
            conn,
            request,
            session,
            "passwords.collection.access.revoke",
            after={"collection": row["name"], "group": group},
        )
    return await _public(pool, settings)


@router.post("/apply", status_code=202, dependencies=[Depends(requires("passwords.write"))])
async def apply_now(
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Send the node its configuration again and reconcile the vault now."""
    async with pool.acquire() as conn:
        task_id = await dispatch(conn, settings, session.principal, sync_now=True)
        await _record(conn, request, session, "passwords.apply")
    summary = await _reconcile_patiently(pool, settings)
    return {"task": task_id, "summary": summary}
