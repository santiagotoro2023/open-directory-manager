"""Delegated administration: roles, their permissions, and who holds them.

Managing delegation is itself reserved for domain administrators.
"""

from __future__ import annotations

import re
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import authz, directory, objects
from .config import Settings, get_settings
from .routes_directory import _audit_context, _bound
from .security import get_pool, require_admin, requires_domain_admin
from .sessions import Session

router = APIRouter(
    prefix="/api/v1/rbac",
    tags=["rbac"],
    dependencies=[Depends(requires_domain_admin())],
)

ROLE_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")

Dn = Annotated[str, Field(min_length=3, max_length=1024)]


class RoleRequest(BaseModel):
    name: Annotated[str, Field(min_length=2, max_length=32)]
    description: Annotated[str, Field(default="", max_length=256)] = ""
    permissions: Annotated[list[str], Field(min_length=1, max_length=64)]


class AssignmentRequest(BaseModel):
    role_name: Annotated[str, Field(min_length=2, max_length=32)]
    principal_dn: Dn
    scope_dn: Dn
    description: Annotated[str, Field(default="", max_length=256)] = ""


@router.get("/permissions")
async def list_permissions() -> dict[str, Any]:
    """Every permission a role can hold."""
    return {"permissions": list(authz.PERMISSIONS), "wildcard": authz.WILDCARD}


@router.get("/roles")
async def list_roles(pool: asyncpg.Pool = Depends(get_pool)) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT r.name, r.description, r.builtin,
               coalesce(array_agg(p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}')
                   AS permissions
        FROM rbac_role r
        LEFT JOIN rbac_role_permission p ON p.role_name = r.name
        GROUP BY r.name, r.description, r.builtin
        ORDER BY r.builtin DESC, r.name
        """
    )
    return {"roles": [dict(row) for row in rows]}


@router.post("/roles", status_code=201)
async def create_role(
    body: RoleRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    if not ROLE_NAME_RE.match(body.name):
        raise objects.ObjectError("role names are lower case letters, digits and dashes")
    unknown = set(body.permissions) - set(authz.PERMISSIONS) - {authz.WILDCARD}
    if unknown:
        raise objects.ObjectError(f"unknown permissions: {', '.join(sorted(unknown))}")

    async with _audit_context(
        request, session, pool, "rbac.role.create", object_type="rbac_role", object_dn=body.name
    ) as entry:
        async with pool.acquire() as conn, conn.transaction():
            existing = await conn.fetchrow(
                "SELECT builtin FROM rbac_role WHERE name = $1", body.name
            )
            if existing and existing["builtin"]:
                raise objects.ProtectedObject("built-in roles cannot be redefined")
            await conn.execute(
                """
                INSERT INTO rbac_role (name, description, builtin) VALUES ($1, $2, false)
                ON CONFLICT (name) DO UPDATE SET description = excluded.description
                """,
                body.name,
                body.description,
            )
            await conn.execute(
                "DELETE FROM rbac_role_permission WHERE role_name = $1", body.name
            )
            await conn.executemany(
                "INSERT INTO rbac_role_permission (role_name, permission) VALUES ($1, $2)",
                [(body.name, permission) for permission in sorted(set(body.permissions))],
            )
        entry.after = {"permissions": sorted(set(body.permissions))}
        return {"name": body.name, "permissions": sorted(set(body.permissions))}


@router.delete("/role", status_code=204)
async def delete_role(
    request: Request,
    name: Annotated[str, Query(min_length=2, max_length=32)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
):
    async with _audit_context(
        request, session, pool, "rbac.role.delete", object_type="rbac_role", object_dn=name
    ) as entry:
        row = await pool.fetchrow("SELECT * FROM rbac_role WHERE name = $1", name)
        if row is None:
            raise objects.NotFound("no such role")
        if row["builtin"]:
            raise objects.ProtectedObject("built-in roles cannot be deleted")
        entry.before = {"description": row["description"]}
        await pool.execute("DELETE FROM rbac_role WHERE name = $1", name)


@router.get("/assignments")
async def list_assignments(
    pool: asyncpg.Pool = Depends(get_pool),
    scope_dn: Annotated[str | None, Query(max_length=1024)] = None,
) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT id, role_name, principal_sid, principal_name, scope_dn, description,
               granted_by, granted_at
        FROM rbac_assignment
        WHERE $1::text IS NULL OR scope_dn = $1
        ORDER BY scope_dn, role_name, principal_name
        """,
        scope_dn,
    )
    return {"assignments": [{**dict(row), "id": str(row["id"])} for row in rows]}


@router.post("/assignments", status_code=201)
async def create_assignment(
    body: AssignmentRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Grant a role to a user or group at an OU scope."""
    async with _audit_context(
        request,
        session,
        pool,
        "rbac.assign",
        object_type="rbac_assignment",
        object_dn=body.scope_dn,
    ) as entry:
        if not await pool.fetchval("SELECT 1 FROM rbac_role WHERE name = $1", body.role_name):
            raise objects.NotFound(f"no such role {body.role_name!r}")

        async with _bound(settings, write=False) as conn:
            principal = await run_in_threadpool(objects.get, conn, settings, body.principal_dn)
            # Proves the scope exists and is inside the domain.
            await run_in_threadpool(objects.get, conn, settings, body.scope_dn)
            sid = await run_in_threadpool(
                directory.read_sid, principal.get("objectSid")
            )
        if not sid:
            raise objects.ObjectError("the principal has no resolvable SID")

        row = await pool.fetchrow(
            """
            INSERT INTO rbac_assignment (role_name, principal_sid, principal_name, scope_dn,
                                         description, granted_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (role_name, principal_sid, scope_dn) DO UPDATE
                SET description = excluded.description, granted_by = excluded.granted_by,
                    granted_at = now()
            RETURNING id
            """,
            body.role_name,
            sid,
            str(principal.get("sAMAccountName") or principal.get("cn") or body.principal_dn),
            body.scope_dn,
            body.description,
            session.principal,
        )
        entry.after = {
            "role": body.role_name,
            "principal": body.principal_dn,
            "scope": body.scope_dn,
        }
        return {"id": str(row["id"]), "role_name": body.role_name, "scope_dn": body.scope_dn}


@router.delete("/assignment", status_code=204)
async def delete_assignment(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
):
    async with _audit_context(
        request, session, pool, "rbac.unassign", object_type="rbac_assignment"
    ) as entry:
        row = await pool.fetchrow("SELECT * FROM rbac_assignment WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such assignment")
        entry.object_dn = row["scope_dn"]
        entry.before = {
            "role": row["role_name"],
            "principal": row["principal_name"],
            "scope": row["scope_dn"],
        }
        await pool.execute("DELETE FROM rbac_assignment WHERE id = $1::uuid", id)
