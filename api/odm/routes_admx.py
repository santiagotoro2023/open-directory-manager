"""Administrative template import (CLAUDE.md §3.6).

Vendors ship ADMX plus ADML; an administrator uploads the pair and ODM
parses them into definitions the settings UI renders as real form controls.
Files arrive base64-encoded in JSON so the API keeps a single content type
and no multipart parser.
"""

from __future__ import annotations

import base64
import binascii
import json
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import admx, objects
from .routes_directory import _audit_context
from .security import get_pool, require_admin
from .sessions import Session

router = APIRouter(prefix="/api/v1/admx", tags=["admx"])

# 8 MB of XML is ~11 MB base64; the parser enforces the real limit.
Encoded = Annotated[str, Field(min_length=1, max_length=12_000_000)]


class UploadTemplate(BaseModel):
    file_name: Annotated[str, Field(min_length=1, max_length=128)]
    admx: Encoded
    adml: Encoded | None = None


def _decode(field: str, payload: str) -> bytes:
    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise objects.ObjectError(f"{field} is not valid base64") from exc


@router.get("/templates")
async def list_templates(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT t.*, count(p.id) FILTER (WHERE p.applicable) AS applicable_count
        FROM admx_template t LEFT JOIN admx_policy p ON p.template_id = t.id
        GROUP BY t.id ORDER BY lower(t.display_name), t.namespace
        """
    )
    return {"templates": [{**dict(row), "id": str(row["id"])} for row in rows]}


@router.post("/templates", status_code=201)
async def upload_template(
    body: UploadTemplate,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    async with _audit_context(
        request, session, pool, "admx.import", object_type="admx", object_dn=body.file_name
    ) as entry:
        admx_bytes = _decode("admx", body.admx)
        adml_bytes = _decode("adml", body.adml) if body.adml else None

        try:
            template = await run_in_threadpool(
                admx.parse, admx_bytes, adml_bytes, body.file_name
            )
        except admx.AdmxError as exc:
            raise objects.ObjectError(str(exc)) from exc

        applicable = sum(1 for p in template.policies if admx.target_of(p.registry_key))

        async with pool.acquire() as conn, conn.transaction():
            # Re-importing a namespace replaces it, the way a newer ADMX file
            # supersedes an older one.
            await conn.execute("DELETE FROM admx_template WHERE namespace = $1", template.namespace)
            template_id = await conn.fetchval(
                """
                INSERT INTO admx_template (namespace, prefix, file_name, display_name, revision,
                                           policy_count, has_adml, uploaded_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
                """,
                template.namespace,
                template.prefix,
                body.file_name,
                template.display_name,
                template.revision,
                len(template.policies),
                adml_bytes is not None,
                session.principal,
            )
            await conn.executemany(
                """
                INSERT INTO admx_category (template_id, name, display_name, parent)
                VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
                """,
                [(template_id, c.name, c.display_name, c.parent) for c in template.categories],
            )
            await conn.executemany(
                """
                INSERT INTO admx_policy (id, template_id, name, display_name, explain_text,
                                         policy_class, category, registry_key, value_name,
                                         supported_on, enabled_value, disabled_value, elements,
                                         applicable)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
                        $13::jsonb, $14)
                ON CONFLICT (id) DO NOTHING
                """,
                [
                    (
                        p.id,
                        template_id,
                        p.name,
                        p.display_name,
                        p.explain_text,
                        p.policy_class,
                        p.category,
                        p.registry_key,
                        p.value_name,
                        p.supported_on,
                        json.dumps(p.enabled_value),
                        json.dumps(p.disabled_value),
                        json.dumps([e.as_json() for e in p.elements]),
                        admx.target_of(p.registry_key) is not None,
                    )
                    for p in template.policies
                ],
            )

        entry.after = {
            "namespace": template.namespace,
            "policies": len(template.policies),
            "applicable": applicable,
        }
        return {
            "id": str(template_id),
            "namespace": template.namespace,
            "display_name": template.display_name,
            "policy_count": len(template.policies),
            "applicable_count": applicable,
            "categories": len(template.categories),
        }


@router.delete("/template", status_code=204)
async def delete_template(
    request: Request,
    id: str = Query(max_length=64),
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
):
    async with _audit_context(
        request, session, pool, "admx.remove", object_type="admx", object_dn=id
    ) as entry:
        row = await pool.fetchrow("SELECT * FROM admx_template WHERE id = $1::uuid", id)
        if row is None:
            raise objects.NotFound("no such administrative template")
        entry.before = {"namespace": row["namespace"], "policies": row["policy_count"]}
        # Group policy objects keep any selections that referenced it; RSoP
        # reports them as "template not imported" rather than silently
        # dropping what an operator configured.
        await pool.execute("DELETE FROM admx_template WHERE id = $1::uuid", id)


@router.get("/categories")
async def list_categories(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT c.name, c.display_name, c.parent, count(p.id) AS policy_count
        FROM admx_category c
        LEFT JOIN admx_policy p ON p.category = c.name
        GROUP BY c.name, c.display_name, c.parent
        HAVING count(p.id) > 0
        ORDER BY lower(c.display_name)
        """
    )
    return {"categories": [dict(row) for row in rows]}


@router.get("/policies")
async def list_policies(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    query: Annotated[str | None, Query(max_length=128)] = None,
    category: Annotated[str | None, Query(max_length=256)] = None,
    applicable_only: bool = True,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT id, display_name, explain_text, policy_class, category, registry_key,
               value_name, supported_on, elements, applicable
        FROM admx_policy
        WHERE ($1::text IS NULL OR display_name ILIKE '%' || $1 || '%' OR id ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR category = $2)
          AND (NOT $3 OR applicable)
        ORDER BY lower(display_name)
        LIMIT $4
        """,
        query,
        category,
        applicable_only,
        limit,
    )
    return {
        "policies": [{**dict(row), "elements": json.loads(row["elements"])} for row in rows]
    }
