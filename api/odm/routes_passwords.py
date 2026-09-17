"""The password-manager role: Vaultwarden, run by ODM.

What the console adds to a Vaultwarden server is the directory. People do
not sign up; they are invited because they are in a group, through
Bitwarden's own directory connector, which the node runs against the domain
on a timer with a read-only account the console makes for it. Inside the
vault an organisation holds the collections; the connector keeps the
organisation's groups and members in step with the directory, and the
organisation's administrator decides once which group sees which
collection. Sales joins the domain group, and Sales sees the Sales vault.

The vault is reached at the console's own address, /vault, and the console
carries the traffic to the node (vaultproxy.py); people sign in with their
domain account through the console's OpenID provider (oidc.py). So there
is one address, one certificate and one sign-in for the whole thing, and
the server it runs on is a detail nobody needs to know.

The console holds one row of configuration. Saving it, pressing Apply, or
installing the role sends it to the node as a task: the certificate from
the domain authority, the vault's address, the sync's credentials and its
schedule.
"""

from __future__ import annotations

import secrets
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from . import audit, ca, objects, oidc, tasks, vaultproxy
from .config import Settings, get_settings
from .policy_schema import PRINCIPAL_RE
from .routes_directory import _bound
from .security import client_ip, get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/passwords", tags=["passwords"])

SYNC_ACCOUNT = "odm-passwords-sync"


class PasswordManagerConfig(BaseModel):
    org_client_id: Annotated[str, Field(max_length=128)] = ""
    org_client_secret: Annotated[str, Field(max_length=256)] = ""
    sync_groups: Annotated[
        list[Annotated[str, Field(max_length=64)]], Field(default_factory=list, max_length=100)
    ]
    sync_every_hours: Annotated[int, Field(ge=1, le=168)] = 1
    # Sign in with the domain account, through the console; and whether
    # that is the only way in.
    sso_enabled: bool = True
    sso_only: bool = True
    smtp_host: Annotated[str, Field(max_length=253)] = ""
    smtp_port: Annotated[int, Field(ge=1, le=65535)] = 587
    smtp_from: Annotated[str, Field(max_length=253)] = ""
    smtp_username: Annotated[str, Field(max_length=253)] = ""
    smtp_password: Annotated[str, Field(max_length=256)] = ""

    @field_validator("sync_groups")
    @classmethod
    def _groups(cls, value: list[str]) -> list[str]:
        for group in value:
            if not PRINCIPAL_RE.match(group.lstrip("%")):
                raise ValueError(f"{group!r} is not a group name")
        return [group.lstrip("%") for group in value]

    @field_validator("org_client_id", "org_client_secret", "smtp_host", "smtp_from",
                     "smtp_username", "smtp_password")
    @classmethod
    def _plain(cls, value: str) -> str:
        if any(character in value for character in "\n\r\x00\"'"):
            raise ValueError("a value is one line without quotes")
        return value.strip()


async def _node(pool: asyncpg.Pool) -> str:
    return await pool.fetchval(
        "SELECT node_fqdn FROM server_role WHERE role_name = 'password-manager'"
        " AND state = 'active' ORDER BY updated_at DESC LIMIT 1"
    ) or ""


def _public(row: asyncpg.Record, node: str, settings: Settings) -> dict[str, Any]:
    return {
        "installed": bool(node),
        "node_fqdn": node,
        "vault_url": vaultproxy.vault_url(settings),
        "ca_ready": ca.initialised(settings),
        "org_client_id": row["org_client_id"],
        "org_configured": bool(row["org_client_id"] and row["org_client_secret"]),
        "sync_groups": list(row["sync_groups"] or []) if isinstance(row["sync_groups"], list)
        else __import__("json").loads(row["sync_groups"] or "[]"),
        "sync_every_hours": row["sync_every_hours"],
        "sso_enabled": row["sso_enabled"],
        "sso_only": row["sso_only"],
        "sync_account": row["sync_account"],
        "smtp_host": row["smtp_host"],
        "smtp_port": row["smtp_port"],
        "smtp_from": row["smtp_from"],
        "smtp_username": row["smtp_username"],
        "smtp_configured": bool(row["smtp_host"]),
        "admin_token": row["admin_token"],
        "last_applied_at": row["last_applied_at"],
        "last_result": row["last_result"],
        "updated_at": row["updated_at"],
    }


@router.get("", dependencies=[Depends(requires("passwords.read"))])
async def status(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    row = await pool.fetchrow("SELECT * FROM password_manager WHERE id = 1")
    node = await _node(pool)
    return _public(row, node, settings)


async def _ensure_sync_account(
    conn: asyncpg.Connection, settings: Settings, row: asyncpg.Record
) -> tuple[str, str]:
    """The read-only directory account the connector binds with, made once.

    A domain user with no group memberships and a random password reads what
    every domain user may read: names, mail addresses and group members —
    which is all the connector needs.
    """
    if row["sync_account"] and row["sync_password"]:
        return row["sync_account"], row["sync_password"]
    password = secrets.token_urlsafe(24)
    async with _bound(settings, write=True) as ldap:
        try:
            await run_in_threadpool(
                objects.create_user,
                ldap,
                settings,
                {
                    "sam_account_name": SYNC_ACCOUNT,
                    "name": "ODM password-manager sync",
                    "container": f"CN=Users,{settings.base_dn}",
                    "description": (
                        "Reads the directory for the password manager's sync. Made by ODM."
                    ),
                    "password": password,
                },
            )
        except objects.ObjectError as exc:
            # It exists from an earlier configuration whose password the
            # console no longer has: give it a new one.
            if "exist" not in str(exc).lower():
                raise
            found = await run_in_threadpool(
                objects.find_user, ldap, settings, sam_account_name=SYNC_ACCOUNT
            )
            await run_in_threadpool(
                objects.set_password, ldap, settings, found["distinguishedName"], password, False
            )
    account = f"{SYNC_ACCOUNT}@{settings.domain}"
    await conn.execute(
        "UPDATE password_manager SET sync_account = $1, sync_password = $2, updated_at = now()"
        " WHERE id = 1",
        account, password,
    )
    return account, password


async def dispatch(
    conn: asyncpg.Connection, settings: Settings, actor: str, *, sync_now: bool
) -> str:
    """Send the configuration to the node. Also called when the role's
    installation finishes, so the vault gets its certificate and its
    address before anyone opens it."""
    row = await conn.fetchrow("SELECT * FROM password_manager WHERE id = 1")
    node = await conn.fetchval(
        "SELECT node_fqdn FROM server_role WHERE role_name = 'password-manager'"
        " AND state = 'active' ORDER BY updated_at DESC LIMIT 1"
    )
    if not node:
        raise objects.ObjectError("the password-manager role is not installed anywhere yet")
    vault_url = vaultproxy.vault_url(settings)
    account, password = "", ""
    if row["org_client_id"] and row["org_client_secret"]:
        account, password = await _ensure_sync_account(conn, settings, row)
    groups = row["sync_groups"]
    if isinstance(groups, str):
        import json  # noqa: PLC0415

        groups = json.loads(groups or "[]")
    # The connector filters by distinguished name; the console knows names.
    group_dns: list[str] = []
    if groups:
        async with _bound(settings, write=False) as ldap:
            for group in groups:
                found = await run_in_threadpool(objects.find_group, ldap, settings, group)
                group_dns.append(str(found["distinguishedName"]))
    # The vault's sign-in goes through the console: the vault is a client
    # of the domain's OpenID provider, registered here, its secret made
    # once and kept on this row for the node.
    sso_client_id, sso_client_secret = row["sso_client_id"], row["sso_client_secret"]
    if row["sso_enabled"]:
        redirects = [f"{vault_url}/identity/connect/oidc-signin"]
        if not sso_client_id or not sso_client_secret:
            sso_client_id = "password-manager"
            sso_client_secret = await oidc.register_client(
                conn, sso_client_id, "the password manager", redirects
            )
            await conn.execute(
                "UPDATE password_manager SET sso_client_id = $1, sso_client_secret = $2"
                " WHERE id = 1",
                sso_client_id, sso_client_secret,
            )
        else:
            await oidc.update_redirects(conn, sso_client_id, redirects)
    payload = {
        "vault_url": vault_url,
        "server_certificate": ca.initialised(settings),
        "sso_enabled": row["sso_enabled"],
        "sso_only": row["sso_only"],
        "sso_authority": oidc.issuer(settings),
        "sso_client_id": sso_client_id,
        "sso_client_secret": sso_client_secret,
        "org_client_id": row["org_client_id"],
        "org_client_secret": row["org_client_secret"],
        "ldap_host": settings.ldap_uri.removeprefix("ldaps://").split("/")[0],
        "base_dn": settings.base_dn,
        "mail_domain": settings.domain,
        "sync_account": account,
        "sync_password": password,
        "sync_groups": list(groups),
        "sync_group_dns": group_dns,
        "sync_every_hours": row["sync_every_hours"],
        "sync_now": sync_now,
        "smtp_host": row["smtp_host"],
        "smtp_port": row["smtp_port"],
        "smtp_from": row["smtp_from"],
        "smtp_username": row["smtp_username"],
        "smtp_password": row["smtp_password"],
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
        " last_result = 'applying' WHERE id = 1",
        node,
    )
    return str(task_id)


@router.put("", dependencies=[Depends(requires("passwords.write"))])
async def configure(
    body: PasswordManagerConfig,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Save the configuration and send it to the node."""
    async with pool.acquire() as conn:
        current = await conn.fetchrow("SELECT * FROM password_manager WHERE id = 1")
        # A secret left blank keeps what is there: the form never shows it.
        secret = body.org_client_secret or current["org_client_secret"]
        smtp_password = body.smtp_password or current["smtp_password"]
        import json  # noqa: PLC0415

        await conn.execute(
            """
            UPDATE password_manager
            SET org_client_id = $1, org_client_secret = $2, sync_groups = $3::jsonb,
                sync_every_hours = $4, smtp_host = $5, smtp_port = $6, smtp_from = $7,
                smtp_username = $8, smtp_password = $9, sso_enabled = $10, sso_only = $11,
                updated_at = now()
            WHERE id = 1
            """,
            body.org_client_id, secret, json.dumps(body.sync_groups),
            body.sync_every_hours, body.smtp_host, body.smtp_port, body.smtp_from,
            body.smtp_username, smtp_password, body.sso_enabled, body.sso_only,
        )
        task_id = await dispatch(conn, settings, session.principal, sync_now=True)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="passwords.configure",
            outcome="success",
            object_type="role",
            object_dn="password-manager",
            after={
                "sync_groups": body.sync_groups,
                "sync_every_hours": body.sync_every_hours, "org": bool(body.org_client_id),
                "sso_enabled": body.sso_enabled, "sso_only": body.sso_only,
            },
        )
        row = await conn.fetchrow("SELECT * FROM password_manager WHERE id = 1")
    return {"task": task_id, **_public(row, await _node(pool), settings)}


@router.post("/apply", status_code=202, dependencies=[Depends(requires("passwords.write"))])
async def apply_now(
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Send the configuration again, and run a sync now."""
    async with pool.acquire() as conn:
        task_id = await dispatch(conn, settings, session.principal, sync_now=True)
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action="passwords.apply",
            outcome="success",
            object_type="role",
            object_dn="password-manager",
        )
    return {"task": task_id}


@router.post("/admin-token", dependencies=[Depends(requires("passwords.write"))])
async def record_admin_token(
    body: dict[str, str],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Keep the admin token the installer printed, so the console can show
    the admin page's link with it. Optional; the node keeps its own copy."""
    token = str(body.get("token") or "").strip()
    if not token or len(token) > 128 or any(c in token for c in "\n\r\x00 "):
        raise objects.ObjectError("that is not the token the installer printed")
    await pool.execute("UPDATE password_manager SET admin_token = $1 WHERE id = 1", token)
    return {"ok": True}
