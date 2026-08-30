"""Group Policy management: objects, links, inheritance and RSoP preview."""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import objects, rsop, sysvol
from .config import Settings, get_settings
from .policy_schema import PolicySettings, Targeting
from .routes_directory import _audit_context, _bound
from .security import get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/policy", tags=["policy"])

Dn = Annotated[str, Field(min_length=3, max_length=1024)]


class CreateGpo(BaseModel):
    display_name: Annotated[str, Field(min_length=1, max_length=128)]
    description: Annotated[str, Field(default="", max_length=1024)] = ""


class UpdateGpo(BaseModel):
    guid: uuid.UUID
    display_name: Annotated[str | None, Field(default=None, min_length=1, max_length=128)] = None
    description: Annotated[str | None, Field(default=None, max_length=1024)] = None
    enabled: bool | None = None
    settings: PolicySettings | None = None
    security_filter: Annotated[list[Dn] | None, Field(default=None, max_length=64)] = None
    targeting: Targeting | None = None


class CreateLink(BaseModel):
    gpo_guid: uuid.UUID
    target_dn: Dn
    enforced: bool = False
    enabled: bool = True


class UpdateLink(BaseModel):
    id: uuid.UUID
    link_order: Annotated[int | None, Field(default=None, ge=1, le=999)] = None
    enforced: bool | None = None
    enabled: bool | None = None


class Inheritance(BaseModel):
    ou_dn: Dn
    block_inheritance: bool


def _gpo_json(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "guid": str(row["guid"]),
        "display_name": row["display_name"],
        "description": row["description"],
        "enabled": row["enabled"],
        "version": row["version"],
        "settings": json.loads(row["settings"]),
        "security_filter": json.loads(row["security_filter"]),
        "targeting": json.loads(row["targeting"]),
        "updated_at": row["updated_at"],
    }


async def _mirror_links(pool: asyncpg.Pool, settings: Settings, target_dn: str) -> None:
    """Rewrite the target's gPLink from ODM's links (no-op unless mirroring)."""
    if not sysvol.enabled(settings):
        return
    rows = await pool.fetch(
        "SELECT gpo_guid, link_order, enforced, enabled FROM gpo_link WHERE target_dn = $1",
        target_dn,
    )
    links = [dict(row) for row in rows]
    async with _bound(settings, write=True) as conn:
        await run_in_threadpool(sysvol.write_links, conn, settings, target_dn, links)


# -------------------------------------------------------------------- GPOs ---


@router.get("/gpos", dependencies=[Depends(requires("gpo.read"))])
async def list_gpos(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT g.*, count(l.id) AS link_count
        FROM gpo g LEFT JOIN gpo_link l ON l.gpo_guid = g.guid
        GROUP BY g.guid ORDER BY lower(g.display_name)
        """
    )
    return {
        "gpos": [{**_gpo_json(row), "link_count": row["link_count"]} for row in rows]
    }


@router.get("/gpo", dependencies=[Depends(requires("gpo.read"))])
async def read_gpo(
    guid: uuid.UUID,
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    row = await pool.fetchrow("SELECT * FROM gpo WHERE guid = $1", guid)
    if row is None:
        raise objects.NotFound("no such group policy object")
    links = await pool.fetch(
        "SELECT id, target_dn, link_order, enforced, enabled FROM gpo_link WHERE gpo_guid = $1"
        " ORDER BY target_dn",
        guid,
    )
    return {
        **_gpo_json(row),
        "links": [{**dict(link), "id": str(link["id"])} for link in links],
    }


@router.post("/gpos", status_code=201, dependencies=[Depends(requires("gpo.write"))])
async def create_gpo(
    body: CreateGpo,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    guid = uuid.uuid4()
    async with _audit_context(
        request, session, pool, "gpo.create", object_type="gpo", object_dn=str(guid)
    ) as entry:
        if sysvol.enabled(settings):
            async with _bound(settings, write=True) as conn:
                await run_in_threadpool(
                    sysvol.create, conn, settings, str(guid), body.display_name
                )
        row = await pool.fetchrow(
            """
            INSERT INTO gpo (guid, display_name, description, created_by)
            VALUES ($1, $2, $3, $4) RETURNING *
            """,
            guid,
            body.display_name,
            body.description,
            session.principal,
        )
        entry.after = {"display_name": body.display_name, "description": body.description}
        return _gpo_json(row)


@router.patch("/gpo", dependencies=[Depends(requires("gpo.write"))])
async def update_gpo(
    body: UpdateGpo,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with _audit_context(
        request, session, pool, "gpo.update", object_type="gpo", object_dn=str(body.guid)
    ) as entry:
        before = await pool.fetchrow("SELECT * FROM gpo WHERE guid = $1", body.guid)
        if before is None:
            raise objects.NotFound("no such group policy object")

        row = await pool.fetchrow(
            """
            UPDATE gpo SET
                display_name    = coalesce($2, display_name),
                description     = coalesce($3, description),
                enabled         = coalesce($4, enabled),
                settings        = coalesce($5::jsonb, settings),
                security_filter = coalesce($6::jsonb, security_filter),
                targeting       = coalesce($7::jsonb, targeting),
                version         = version + 1,
                updated_at      = now()
            WHERE guid = $1
            RETURNING *
            """,
            body.guid,
            body.display_name,
            body.description,
            body.enabled,
            json.dumps(body.settings.stored()) if body.settings is not None else None,
            json.dumps(body.security_filter) if body.security_filter is not None else None,
            json.dumps(body.targeting.model_dump(exclude_none=True))
            if body.targeting is not None
            else None,
        )
        if sysvol.enabled(settings):
            async with _bound(settings, write=True) as conn:
                if body.display_name:
                    await run_in_threadpool(
                        sysvol.rename, conn, settings, str(body.guid), body.display_name
                    )
                await run_in_threadpool(
                    sysvol.bump_version, conn, settings, str(body.guid), row["version"]
                )

        entry.before = _gpo_json(before)
        entry.after = _gpo_json(row)
        return _gpo_json(row)


@router.delete("/gpo", status_code=204, dependencies=[Depends(requires("gpo.write"))])
async def delete_gpo(
    request: Request,
    guid: uuid.UUID,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
):
    async with _audit_context(
        request, session, pool, "gpo.delete", object_type="gpo", object_dn=str(guid)
    ) as entry:
        row = await pool.fetchrow("SELECT * FROM gpo WHERE guid = $1", guid)
        if row is None:
            raise objects.NotFound("no such group policy object")
        targets = [
            r["target_dn"]
            for r in await pool.fetch("SELECT target_dn FROM gpo_link WHERE gpo_guid = $1", guid)
        ]
        entry.before = _gpo_json(row)

        # A policy object is as deletable-by-accident as a user, and the
        # console says so before it deletes one. It has to actually be there
        # afterwards: this used to delete outright, so the dialog promised a
        # recycle bin the object never reached.
        await pool.execute(
            """
            INSERT INTO deleted_object (object_dn, object_type, display_name, parent_dn,
                                        attributes, memberships, members, deleted_by,
                                        purge_after)
            VALUES ($1, 'gpo', $2, '', $3::jsonb, '[]'::jsonb, $4::jsonb, $5,
                    now() + $6::interval)
            """,
            f"CN={{{guid}}},CN=Policies,CN=System,{settings.base_dn}",
            row["display_name"],
            json.dumps(_gpo_json(row)),
            json.dumps(targets),
            session.principal,
            timedelta(days=settings.retention_days),
        )

        # Links cascade in the database; the LDAP side has to be rewritten.
        await pool.execute("DELETE FROM gpo WHERE guid = $1", guid)
        if sysvol.enabled(settings):
            async with _bound(settings, write=True) as conn:
                await run_in_threadpool(sysvol.delete, conn, settings, str(guid))
        for target in targets:
            await _mirror_links(pool, settings, target)


# ------------------------------------------------------------------- links ---


@router.get("/links", dependencies=[Depends(requires("gpo.read"))])
async def list_links(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    target_dn: Annotated[str | None, Query(max_length=1024)] = None,
) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT l.id, l.gpo_guid, l.target_dn, l.link_order, l.enforced, l.enabled,
               g.display_name, g.enabled AS gpo_enabled
        FROM gpo_link l JOIN gpo g ON g.guid = l.gpo_guid
        WHERE $1::text IS NULL OR l.target_dn = $1
        ORDER BY l.target_dn, l.link_order
        """,
        target_dn,
    )
    return {
        "links": [
            {**dict(row), "id": str(row["id"]), "gpo_guid": str(row["gpo_guid"])} for row in rows
        ]
    }


@router.post("/links", status_code=201, dependencies=[Depends(requires("gpo.write"))])
async def create_link(
    body: CreateLink,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with _audit_context(
        request, session, pool, "gpo.link", object_type="gpo", object_dn=body.target_dn
    ) as entry:
        async with _bound(settings, write=False) as conn:
            # Proves the target exists and is inside the domain.
            await run_in_threadpool(objects.get, conn, settings, body.target_dn)

        row = await pool.fetchrow(
            """
            INSERT INTO gpo_link (gpo_guid, target_dn, link_order, enforced, enabled)
            VALUES ($1, $2,
                    (SELECT coalesce(max(link_order), 0) + 1 FROM gpo_link WHERE target_dn = $2),
                    $3, $4)
            RETURNING id, link_order
            """,
            body.gpo_guid,
            body.target_dn,
            body.enforced,
            body.enabled,
        )
        await _mirror_links(pool, settings, body.target_dn)
        entry.after = {
            "gpo_guid": str(body.gpo_guid),
            "target_dn": body.target_dn,
            "link_order": row["link_order"],
            "enforced": body.enforced,
        }
        return {"id": str(row["id"]), "link_order": row["link_order"]}


@router.patch("/link", dependencies=[Depends(requires("gpo.write"))])
async def update_link(
    body: UpdateLink,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with _audit_context(
        request, session, pool, "gpo.link.update", object_type="gpo"
    ) as entry:
        before = await pool.fetchrow("SELECT * FROM gpo_link WHERE id = $1", body.id)
        if before is None:
            raise objects.NotFound("no such link")
        entry.object_dn = before["target_dn"]
        entry.before = {k: before[k] for k in ("link_order", "enforced", "enabled")}

        async with pool.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                UPDATE gpo_link SET enforced = coalesce($2, enforced),
                                    enabled = coalesce($3, enabled),
                                    updated_at = now()
                WHERE id = $1
                """,
                body.id,
                body.enforced,
                body.enabled,
            )
            if body.link_order is not None and body.link_order != before["link_order"]:
                await _reorder(conn, before["target_dn"], body.id, body.link_order)

        await _mirror_links(pool, settings, before["target_dn"])
        row = await pool.fetchrow("SELECT * FROM gpo_link WHERE id = $1", body.id)
        entry.after = {k: row[k] for k in ("link_order", "enforced", "enabled")}
        return {**entry.after, "id": str(body.id)}


async def _reorder(conn: asyncpg.Connection, target_dn: str, link_id: uuid.UUID, position: int):
    """Move one link and renumber the rest, 1..n with no gaps.

    The (target_dn, link_order) uniqueness constraint is deferred, so the
    intermediate states inside this transaction are allowed.
    """
    rows = await conn.fetch(
        "SELECT id FROM gpo_link WHERE target_dn = $1 ORDER BY link_order", target_dn
    )
    ids = [row["id"] for row in rows if row["id"] != link_id]
    ids.insert(max(0, min(position - 1, len(ids))), link_id)
    for index, current in enumerate(ids, start=1):
        await conn.execute("UPDATE gpo_link SET link_order = $2 WHERE id = $1", current, index)


@router.delete("/link", status_code=204, dependencies=[Depends(requires("gpo.write"))])
async def delete_link(
    request: Request,
    id: uuid.UUID,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
):
    async with _audit_context(request, session, pool, "gpo.unlink", object_type="gpo") as entry:
        row = await pool.fetchrow("SELECT * FROM gpo_link WHERE id = $1", id)
        if row is None:
            raise objects.NotFound("no such link")
        entry.object_dn = row["target_dn"]
        entry.before = {"gpo_guid": str(row["gpo_guid"]), "link_order": row["link_order"]}

        async with pool.acquire() as conn, conn.transaction():
            await conn.execute("DELETE FROM gpo_link WHERE id = $1", id)
            remaining = await conn.fetch(
                "SELECT id FROM gpo_link WHERE target_dn = $1 ORDER BY link_order",
                row["target_dn"],
            )
            for index, link in enumerate(remaining, start=1):
                await conn.execute(
                    "UPDATE gpo_link SET link_order = $2 WHERE id = $1", link["id"], index
                )
        await _mirror_links(pool, settings, row["target_dn"])


@router.post("/inheritance", dependencies=[Depends(requires("gpo.write"))])
async def set_inheritance(
    body: Inheritance,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    async with _audit_context(
        request, session, pool, "gpo.inheritance", object_type="ou", object_dn=body.ou_dn
    ) as entry:
        async with _bound(settings, write=True) as conn:
            await run_in_threadpool(objects.get, conn, settings, body.ou_dn)
            if sysvol.enabled(settings):
                await run_in_threadpool(
                    sysvol.write_inheritance, conn, settings, body.ou_dn, body.block_inheritance
                )
        await pool.execute(
            """
            INSERT INTO ou_policy_state (ou_dn, block_inheritance) VALUES ($1, $2)
            ON CONFLICT (ou_dn) DO UPDATE
                SET block_inheritance = excluded.block_inheritance, updated_at = now()
            """,
            body.ou_dn,
            body.block_inheritance,
        )
        entry.after = {"block_inheritance": body.block_inheritance}
        return {"ou_dn": body.ou_dn, "block_inheritance": body.block_inheritance}


# --------------------------------------------------------------- bootstrap ---

# The two policies a domain starts with. Both are ordinary group policy
# objects afterwards: they can be edited, linked elsewhere, enforced or
# unlinked like any other.
DEFAULT_DOMAIN_POLICY = "Default Domain Policy"
DEFAULT_DC_POLICY = "Default Domain Controllers Policy"


def _default_domain_settings(settings: Settings) -> dict[str, Any]:
    return {
        "agent": {"refresh_minutes": settings.agent_refresh_minutes},
        "files": [
            {
                "path": "/etc/issue.net",
                "content": (
                    f"Authorised use only. Activity on this system is logged.\n"
                    f"{settings.domain}\n"
                ),
                "mode": "0644",
                "owner": "root",
                "group": "root",
            }
        ],
    }


def _default_dc_settings(settings: Settings) -> dict[str, Any]:
    return {
        "systemd_units": [{"unit": "ssh.service", "state": "enabled"}],
        "hbac_rules": [
            {"principal": f"%{settings.admin_group}", "service": "all", "access": "allow"}
        ],
    }


@router.post("/bootstrap", dependencies=[Depends(requires("gpo.write"))])
async def bootstrap(
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Create the two default policies and link them, if they are absent.

    Safe to run repeatedly: policies that already exist are left untouched.
    """
    async with _audit_context(
        request, session, pool, "gpo.bootstrap", object_type="gpo"
    ) as entry:
        dc_ou = f"OU=Domain Controllers,{settings.base_dn}"
        created: list[dict[str, str]] = []

        for name, description, document, target in (
            (
                DEFAULT_DOMAIN_POLICY,
                "Baseline applied to every machine in the domain",
                _default_domain_settings(settings),
                settings.base_dn,
            ),
            (
                DEFAULT_DC_POLICY,
                "Baseline applied to the domain controllers",
                _default_dc_settings(settings),
                dc_ou,
            ),
        ):
            if await pool.fetchval("SELECT 1 FROM gpo WHERE display_name = $1", name):
                continue
            guid = uuid.uuid4()
            if sysvol.enabled(settings):
                async with _bound(settings, write=True) as conn:
                    await run_in_threadpool(sysvol.create, conn, settings, str(guid), name)
            await pool.execute(
                """
                INSERT INTO gpo (guid, display_name, description, settings, created_by)
                VALUES ($1, $2, $3, $4::jsonb, $5)
                """,
                guid,
                name,
                description,
                json.dumps(document),
                session.principal,
            )
            await pool.execute(
                """
                INSERT INTO gpo_link (gpo_guid, target_dn, link_order, enforced, enabled)
                VALUES ($1, $2,
                        (SELECT coalesce(max(link_order), 0) + 1 FROM gpo_link
                         WHERE target_dn = $2),
                        false, true)
                ON CONFLICT (gpo_guid, target_dn) DO NOTHING
                """,
                guid,
                target,
            )
            await _mirror_links(pool, settings, target)
            created.append({"guid": str(guid), "display_name": name, "linked_to": target})

        entry.after = {"created": created}
        return {"created": created}


# -------------------------------------------------------------------- RSoP ---


@router.get("/effective", dependencies=[Depends(requires("gpo.read"))])
async def effective(
    dn: Annotated[str, Query(max_length=1024)],
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """What this object would receive right now — the RSoP preview."""
    async with _bound(settings, write=False) as conn:
        return await rsop.build(pool, settings, conn, dn)


@router.get("/reports", dependencies=[Depends(requires("gpo.read"))])
async def reports(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    computer_dn: Annotated[str | None, Query(max_length=1024)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, Any]:
    """What agents actually reported after applying, newest first."""
    rows = await pool.fetch(
        """
        SELECT DISTINCT ON (computer_dn)
               id, computer_dn, hostname, reported_at, agent_version, policy_serial,
               applied_gpos, results, failures
        FROM agent_report
        WHERE $1::text IS NULL OR computer_dn = $1
        ORDER BY computer_dn, reported_at DESC
        LIMIT $2
        """,
        computer_dn,
        limit,
    )
    return {
        "reports": [
            {
                **dict(row),
                "id": str(row["id"]),
                "applied_gpos": json.loads(row["applied_gpos"]),
                "results": json.loads(row["results"]),
            }
            for row in rows
        ]
    }

