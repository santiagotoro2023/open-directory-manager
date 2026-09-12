"""Software an operator uploads directly, for machines with no apt repository
that carries it (CLAUDE.md §3.5).

Uploaded base64-encoded in JSON, like every other file this console accepts,
so the API keeps one content type and no multipart parser — and served back
out as the raw bytes dpkg needs, the same way the agent binary itself is.
"""

from __future__ import annotations

import base64
import binascii
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import custom_packages, objects
from .config import Settings, get_settings
from .routes_agent import Machine, require_machine
from .routes_directory import _audit_context
from .security import get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/packages", tags=["packages"])

# 200 MB of package is ~267 MB base64; custom_packages.save enforces the real
# limit, on the decoded size.
Encoded = Annotated[str, Field(min_length=1, max_length=270_000_000)]


class UploadPackage(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=128)]
    file_name: Annotated[str, Field(min_length=1, max_length=255)]
    content: Encoded


@router.get("", dependencies=[Depends(requires("gpo.read"))])
async def list_packages(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT id, name, file_name, package_name, version, architecture,
               size_bytes, sha256, uploaded_by, uploaded_at
        FROM custom_package ORDER BY lower(name)
        """
    )
    return {"packages": [{**dict(row), "id": str(row["id"])} for row in rows]}


@router.post("", status_code=201, dependencies=[Depends(requires("gpo.write"))])
async def upload_package(
    body: UploadPackage,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Store an uploaded .deb and confirm it is one dpkg can actually read."""
    try:
        content = base64.b64decode(body.content, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise objects.ObjectError("the file is not valid base64") from exc

    async with _audit_context(
        request, session, pool, "package.upload", object_type="custom_package",
        object_dn=body.name,
    ) as entry:
        try:
            package_id, package_name, version, architecture = await run_in_threadpool(
                custom_packages.save, settings, content, body.file_name
            )
        except custom_packages.CustomPackageError as exc:
            raise objects.ObjectError(str(exc)) from exc

        row = await pool.fetchrow(
            """
            INSERT INTO custom_package (id, name, file_name, package_name, version,
                                        architecture, size_bytes, sha256, uploaded_by)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, name, file_name, package_name, version, architecture,
                      size_bytes, sha256, uploaded_by, uploaded_at
            """,
            package_id,
            body.name,
            body.file_name,
            package_name,
            version,
            architecture,
            len(content),
            custom_packages.sha256_of(content),
            session.principal,
        )
        entry.after = {
            "name": body.name,
            "package_name": package_name,
            "version": version,
            "size_bytes": len(content),
        }
        return {**dict(row), "id": str(row["id"])}


@router.delete("/{package_id}", status_code=204, dependencies=[Depends(requires("gpo.write"))])
async def remove_package(
    package_id: str,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
):
    async with _audit_context(
        request, session, pool, "package.remove", object_type="custom_package",
        object_dn=package_id,
    ) as entry:
        row = await pool.fetchrow(
            "SELECT name FROM custom_package WHERE id = $1::uuid", package_id
        )
        if row is None:
            raise objects.NotFound("no such package")
        referenced = await pool.fetchval(
            """
            SELECT array_agg(DISTINCT gpo.display_name) FROM gpo,
                LATERAL jsonb_array_elements(coalesce(gpo.settings->'custom_packages', '[]'))
                    AS item
            WHERE item->>'package_id' = $1
            """,
            package_id,
        )
        if referenced:
            raise objects.ObjectError(
                "still deployed by: " + ", ".join(referenced) + " — remove it there first"
            )
        entry.before = {"name": row["name"]}
        await pool.execute("DELETE FROM custom_package WHERE id = $1::uuid", package_id)
        await run_in_threadpool(custom_packages.delete, settings, package_id)


@router.get("/{package_id}/download")
async def download_package(
    package_id: str,
    machine: Machine = Depends(require_machine),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    """The package itself, for a machine applying it.

    Authenticated as the machine, over the channel it already verified for
    policy — if a machine can be lied to about its policy it can already be
    told to run a script, so a package it was handed by the same channel is
    not a new trust boundary, only a bigger file.
    """
    del machine  # required only to gate this behind require_machine
    row = await pool.fetchrow(
        "SELECT file_name, sha256 FROM custom_package WHERE id = $1::uuid", package_id
    )
    path = custom_packages.path_for(settings, package_id)
    if row is None or not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such package")
    return FileResponse(
        path,
        media_type="application/vnd.debian.binary-package",
        filename=row["file_name"] or f"{package_id}.deb",
        headers={"X-ODM-Package-Sha256": row["sha256"]},
    )
