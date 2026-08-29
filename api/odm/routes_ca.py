"""Certificate authority endpoints.

Issue certificates, publish the root to domain members through Group
Policy, and replace the certificate the administration console is served
with.
"""

from __future__ import annotations

import json
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import ca, objects, roles
from .config import Settings, get_settings
from .routes_directory import _audit_context
from .security import get_pool, require_admin, requires, requires_domain_admin
from .sessions import Session

router = APIRouter(prefix="/api/v1/ca", tags=["ca"])

TRUST_GPO_NAME = "ODM Certificate Trust"


class InitialiseRequest(BaseModel):
    common_name: Annotated[str | None, Field(default=None, max_length=64)] = None


class IssueRequest(BaseModel):
    common_name: Annotated[str, Field(min_length=1, max_length=253)]
    sans: Annotated[list[Annotated[str, Field(max_length=253)]], Field(default_factory=list,
                                                                      max_length=32)]
    profile: Annotated[str, Field(pattern="^(server|client|console)$")] = "server"
    validity_days: Annotated[int, Field(ge=1, le=ca.MAX_VALIDITY_DAYS)] = ca.DEFAULT_VALIDITY_DAYS


class RevokeRequest(BaseModel):
    serial: Annotated[str, Field(min_length=1, max_length=64, pattern="^[0-9a-fA-F]+$")]
    reason: Annotated[str, Field(default="", max_length=256)] = ""


class ConsoleCertificateRequest(BaseModel):
    common_name: Annotated[str, Field(min_length=1, max_length=253)]
    sans: Annotated[list[Annotated[str, Field(max_length=253)]], Field(default_factory=list,
                                                                      max_length=32)]
    validity_days: Annotated[int, Field(ge=1, le=ca.MAX_VALIDITY_DAYS)] = ca.DEFAULT_VALIDITY_DAYS


@router.get("/status", dependencies=[Depends(requires("ca.read"))])
async def status(
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    described = ca.describe(settings)
    if described.get("initialised"):
        described["issued"] = await pool.fetchval(
            "SELECT count(*) FROM ca_certificate WHERE revoked_at IS NULL"
        )
        described["expiring_soon"] = await pool.fetchval(
            """
            SELECT count(*) FROM ca_certificate
            WHERE revoked_at IS NULL AND not_after < now() + interval '30 days'
            """
        )
    return described


@router.post("/initialise", status_code=201, dependencies=[Depends(requires_domain_admin())])
async def initialise(
    body: InitialiseRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Create the root certificate authority."""
    async with _audit_context(
        request, session, pool, "ca.initialise", object_type="ca"
    ) as entry:
        await run_in_threadpool(ca.initialise, settings, body.common_name)
        described = ca.describe(settings)
        entry.after = {"subject": described["subject"], "fingerprint": described["fingerprint"]}
        return described


@router.get("/root", dependencies=[Depends(requires("ca.read"))])
async def root_certificate(settings: Settings = Depends(get_settings)) -> Response:
    """The root certificate, PEM encoded, for manual distribution."""
    return Response(
        content=ca.root_pem(settings),
        media_type="application/x-pem-file",
        headers={"Content-Disposition": 'attachment; filename="odm-root-ca.pem"'},
    )


@router.get("/certificates", dependencies=[Depends(requires("ca.read"))])
async def list_certificates(
    pool: asyncpg.Pool = Depends(get_pool),
    include_revoked: bool = False,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT serial, subject, sans, profile, fingerprint, not_before, not_after,
               issued_by, issued_at, revoked_at, revocation_reason
        FROM ca_certificate
        WHERE $1::boolean OR revoked_at IS NULL
        ORDER BY issued_at DESC
        LIMIT $2
        """,
        include_revoked,
        limit,
    )
    return {
        "certificates": [{**dict(row), "sans": json.loads(row["sans"])} for row in rows]
    }


@router.post("/issue", status_code=201, dependencies=[Depends(requires("ca.issue"))])
async def issue(
    body: IssueRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Issue a certificate and hand back the key once.

    The private key is returned in this response and never stored; if it is
    lost, issue a new certificate.
    """
    async with _audit_context(
        request, session, pool, "ca.issue", object_type="certificate",
        object_dn=body.common_name,
    ) as entry:
        issued = await run_in_threadpool(
            lambda: ca.issue(
                settings,
                common_name=body.common_name,
                sans=body.sans,
                profile=body.profile,
                validity_days=body.validity_days,
            )
        )
        await _record(pool, issued, session.principal)
        entry.after = {
            "serial": issued.serial,
            "profile": issued.profile,
            "not_after": str(issued.not_after),
        }
        return {
            "serial": issued.serial,
            "subject": issued.subject,
            "sans": issued.sans,
            "profile": issued.profile,
            "not_before": issued.not_before,
            "not_after": issued.not_after,
            "fingerprint": issued.fingerprint,
            "certificate_pem": issued.certificate_pem,
            "private_key_pem": issued.private_key_pem,
        }


async def _record(pool: asyncpg.Pool, issued: ca.Issued, actor: str) -> None:
    await pool.execute(
        """
        INSERT INTO ca_certificate (serial, subject, sans, profile, certificate_pem,
                                    fingerprint, not_before, not_after, issued_by)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
        """,
        issued.serial,
        issued.subject,
        json.dumps(issued.sans),
        issued.profile,
        issued.certificate_pem,
        issued.fingerprint,
        issued.not_before,
        issued.not_after,
        actor,
    )


@router.post("/revoke", status_code=204, dependencies=[Depends(requires("ca.issue"))])
async def revoke(
    body: RevokeRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
):
    async with _audit_context(
        request, session, pool, "ca.revoke", object_type="certificate", object_dn=body.serial
    ) as entry:
        row = await pool.fetchrow(
            "SELECT * FROM ca_certificate WHERE serial = $1 AND revoked_at IS NULL", body.serial
        )
        if row is None:
            raise objects.NotFound("no such active certificate")
        entry.before = {"subject": row["subject"], "profile": row["profile"]}
        await pool.execute(
            """
            UPDATE ca_certificate
            SET revoked_at = now(), revoked_by = $2, revocation_reason = $3
            WHERE serial = $1
            """,
            body.serial,
            session.principal,
            body.reason,
        )


@router.get("/crl", dependencies=[Depends(requires("ca.read"))])
async def crl(
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> Response:
    rows = await pool.fetch(
        "SELECT serial, revoked_at FROM ca_certificate WHERE revoked_at IS NOT NULL"
    )
    pem = await run_in_threadpool(
        ca.build_crl, settings, [(row["serial"], row["revoked_at"]) for row in rows]
    )
    return Response(content=pem, media_type="application/x-pem-file")


@router.post("/publish", dependencies=[Depends(requires_domain_admin())])
async def publish_trust(
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Distribute the root certificate to every domain member.

    Creates or updates a group policy object holding the root certificate
    and links it at the domain head. Agents install it into the system trust
    store on their next refresh.
    """
    async with _audit_context(
        request, session, pool, "ca.publish", object_type="gpo", object_dn=TRUST_GPO_NAME
    ) as entry:
        trusted = []
        if ca.initialised(settings):
            trusted.append({"name": "odm-root-ca", "certificate_pem": ca.root_pem(settings)})
        # Everything else the domain has been told to trust goes with it, so
        # one policy object holds the whole trust store rather than one each.
        for row in await pool.fetch("SELECT name, certificate_pem FROM trust_anchor ORDER BY name"):
            trusted.append({"name": row["name"], "certificate_pem": row["certificate_pem"]})
        if not trusted:
            raise objects.ObjectError("there is nothing to publish yet")
        settings_document = {"trusted_certificates": trusted}

        guid = await pool.fetchval(
            "SELECT guid FROM gpo WHERE display_name = $1", TRUST_GPO_NAME
        )
        if guid is None:
            guid = await pool.fetchval(
                """
                INSERT INTO gpo (guid, display_name, description, settings, created_by)
                VALUES (gen_random_uuid(), $1, $2, $3::jsonb, $4)
                RETURNING guid
                """,
                TRUST_GPO_NAME,
                "Installs the domain's trusted certificates into the system trust store",
                json.dumps(settings_document),
                session.principal,
            )
        else:
            await pool.execute(
                """
                UPDATE gpo SET settings = $2::jsonb, version = version + 1, updated_at = now()
                WHERE guid = $1
                """,
                guid,
                json.dumps(settings_document),
            )

        await pool.execute(
            """
            INSERT INTO gpo_link (gpo_guid, target_dn, link_order, enforced, enabled)
            VALUES ($1, $2,
                    (SELECT coalesce(max(link_order), 0) + 1 FROM gpo_link WHERE target_dn = $2),
                    false, true)
            ON CONFLICT (gpo_guid, target_dn) DO NOTHING
            """,
            guid,
            settings.base_dn,
        )
        entry.after = {
            "gpo": str(guid),
            "linked_to": settings.base_dn,
            "certificates": [entry["name"] for entry in trusted],
        }
        return {
            "gpo_guid": str(guid),
            "display_name": TRUST_GPO_NAME,
            "published": [entry["name"] for entry in trusted],
        }


@router.post("/console-certificate", status_code=202,
             dependencies=[Depends(requires_domain_admin())])
async def console_certificate(
    body: ConsoleCertificateRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Replace the console's own certificate with one this CA issues.

    The material is staged where the API can write, and a privileged helper
    installs it and restarts the service. The console is briefly unavailable
    while it restarts.
    """
    async with _audit_context(
        request, session, pool, "ca.console_certificate", object_type="certificate",
        object_dn=body.common_name,
    ) as entry:
        issued = await run_in_threadpool(
            lambda: ca.issue(
                settings,
                common_name=body.common_name,
                sans=body.sans,
                profile="console",
                validity_days=body.validity_days,
            )
        )
        await _record(pool, issued, session.principal)
        await run_in_threadpool(
            roles.stage_console_certificate,
            settings,
            issued.certificate_pem,
            issued.private_key_pem or "",
        )
        entry.after = {"serial": issued.serial, "not_after": str(issued.not_after)}

    # Applied after the response is sent: the helper restarts the service.
    return {
        "serial": issued.serial,
        "fingerprint": issued.fingerprint,
        "not_after": issued.not_after,
        "applied": await run_in_threadpool(roles.apply_console_certificate),
        "note": "the console restarts to pick up the new certificate",
    }


# ------------------------------------------------------------ trust anchors ---


class TrustAnchorRequest(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]
    description: Annotated[str, Field(max_length=255)] = ""
    certificate_pem: Annotated[str, Field(min_length=1, max_length=32_768)]


@router.get("/trusted", dependencies=[Depends(requires("ca.read"))])
async def list_trusted(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Certificates the domain trusts, whoever issued them."""
    rows = await pool.fetch("SELECT * FROM trust_anchor ORDER BY name")
    return {
        "trusted": [
            {
                "id": str(row["id"]),
                "name": row["name"],
                "description": row["description"],
                "subject": row["subject"],
                "issuer": row["issuer"],
                "fingerprint": row["fingerprint"],
                "not_before": row["not_before"],
                "not_after": row["not_after"],
                "is_ca": row["is_ca"],
                "added_by": row["added_by"],
                "added_at": row["added_at"],
            }
            for row in rows
        ]
    }


@router.post("/trusted", status_code=201, dependencies=[Depends(requires_domain_admin())])
async def add_trusted(
    body: TrustAnchorRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """Trust a certificate ODM did not issue.

    The certificate is parsed here, so what is stored is known to be one and
    the console can say whose it is and when it expires.
    """
    name = ca.validate_name(body.name)
    described = ca.inspect_pem(body.certificate_pem)

    async with _audit_context(
        request, session, pool, "ca.trust.add", object_type="certificate", object_dn=name
    ) as entry:
        existing = await pool.fetchval(
            "SELECT 1 FROM trust_anchor WHERE lower(name) = lower($1)", name
        )
        if existing:
            raise objects.ObjectError(f"{name} is already trusted")
        row = await pool.fetchrow(
            """
            INSERT INTO trust_anchor (name, description, certificate_pem, subject, issuer,
                                      fingerprint, not_before, not_after, is_ca, added_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id
            """,
            name,
            body.description,
            body.certificate_pem,
            described["subject"],
            described["issuer"],
            described["fingerprint"],
            described["not_before"],
            described["not_after"],
            described["is_ca"],
            session.principal,
        )
        entry.after = {"name": name, **{k: str(v) for k, v in described.items()}}
        return {"id": str(row["id"]), "name": name, **described}


@router.delete("/trusted", status_code=204, dependencies=[Depends(requires_domain_admin())])
async def remove_trusted(
    request: Request,
    id: Annotated[str, Query(min_length=36, max_length=36)],
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Stop trusting a certificate.

    Removing it here takes it out of the next publish; machines keep it until
    that policy reaches them, so publish afterwards.
    """
    row = await pool.fetchrow("SELECT * FROM trust_anchor WHERE id = $1::uuid", id)
    if row is None:
        raise objects.NotFound("no such certificate")
    async with _audit_context(
        request,
        session,
        pool,
        "ca.trust.remove",
        object_type="certificate",
        object_dn=row["name"],
    ) as entry:
        entry.before = {"name": row["name"], "fingerprint": row["fingerprint"]}
        await pool.execute("DELETE FROM trust_anchor WHERE id = $1::uuid", id)
