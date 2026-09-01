"""Certificate authority endpoints.

Issue certificates, publish the root to domain members through Group
Policy, and replace the certificate the administration console is served
with.
"""

from __future__ import annotations

import json
import socket
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import ca, objects, roles, tasks
from .config import Settings, get_settings
from .routes_directory import _audit_context
from .security import get_pool, require_admin, requires, requires_domain_admin
from .sessions import Session

router = APIRouter(prefix="/api/v1/ca", tags=["ca"])

TRUST_GPO_NAME = "ODM Certificate Trust"


class InitialiseRequest(BaseModel):
    common_name: Annotated[str | None, Field(default=None, max_length=64)] = None
    # A domain authority nobody trusts issues certificates nobody accepts, so
    # publishing is the default rather than a second thing to remember.
    publish_root: bool = True


class IssueRequest(BaseModel):
    common_name: Annotated[str, Field(min_length=1, max_length=253)]
    sans: Annotated[list[Annotated[str, Field(max_length=253)]], Field(default_factory=list,
                                                                      max_length=32)]
    # A profile an operator defined is named here too, so the pattern is the
    # union of the built-in names and what the profile table allows.
    profile: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{1,30}$")] = "server"
    validity_days: Annotated[int, Field(ge=1, le=ca.MAX_VALIDITY_DAYS)] = ca.DEFAULT_VALIDITY_DAYS


class ProfileRequest(BaseModel):
    name: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{1,30}$")]
    description: Annotated[str, Field(default="", max_length=200)] = ""
    purposes: Annotated[list[str], Field(min_length=1, max_length=8)]
    validity_days: Annotated[int, Field(ge=1, le=ca.MAX_VALIDITY_DAYS)] = ca.DEFAULT_VALIDITY_DAYS
    key_size: Annotated[int, Field(default=2048)] = 2048


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
        if body.publish_root:
            # An authority no machine trusts issues certificates no machine
            # accepts. Not fatal: the authority exists either way, and the
            # Publish to domain button is still there.
            try:
                described["published"] = await _publish(pool, settings, session.principal)
            except Exception as exc:  # noqa: BLE001 - reported, not raised
                described["publish_error"] = str(exc)
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
        # A profile the operator defined decides the purposes and the key
        # size; a built-in name means what it has always meant.
        purposes: list[str] | None = None
        key_size = ca.LEAF_KEY_SIZE
        if body.profile not in ca.PROFILES:
            row = await pool.fetchrow(
                "SELECT purposes, key_size FROM certificate_profile WHERE name = $1",
                body.profile,
            )
            if row is None:
                raise objects.ObjectError(f"unknown certificate profile {body.profile!r}")
            purposes = list(row["purposes"])
            key_size = row["key_size"]
        issued = await run_in_threadpool(
            lambda: ca.issue(
                settings,
                common_name=body.common_name,
                sans=body.sans,
                profile=body.profile,
                validity_days=body.validity_days,
                purposes=purposes,
                key_size=key_size,
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


@router.get("/profiles", dependencies=[Depends(requires("ca.read"))])
async def list_profiles(pool: asyncpg.Pool = Depends(get_pool)) -> dict[str, Any]:
    """The profiles a certificate can be issued from.

    The two built-in ones are what AD CS calls Web Server and User; the rest
    are the operator's own, and both kinds are issued the same way.
    """
    rows = await pool.fetch("SELECT * FROM certificate_profile ORDER BY name")
    return {
        "purposes": sorted(ca.PURPOSES),
        "profiles": [
            {
                "name": "server",
                "description": "Server — TLS service",
                "purposes": ["server"],
                "validity_days": ca.DEFAULT_VALIDITY_DAYS,
                "key_size": ca.LEAF_KEY_SIZE,
                "built_in": True,
            },
            {
                "name": "client",
                "description": "Client — authentication",
                "purposes": ["client"],
                "validity_days": ca.DEFAULT_VALIDITY_DAYS,
                "key_size": ca.LEAF_KEY_SIZE,
                "built_in": True,
            },
            *[{**dict(row), "built_in": False} for row in rows],
        ],
    }


@router.post("/profiles", status_code=201, dependencies=[Depends(requires_domain_admin())])
async def create_profile(
    body: ProfileRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    if body.name in ca.PROFILES:
        raise objects.ObjectError(f"{body.name} is a built-in profile")
    unknown = [name for name in body.purposes if name not in ca.PURPOSES]
    if unknown:
        raise objects.ObjectError(f"unknown purpose {unknown[0]!r}")
    if body.key_size not in (2048, 3072, 4096):
        raise objects.ObjectError("key size must be 2048, 3072 or 4096")
    async with _audit_context(
        request, session, pool, "ca.profile.create", object_type="certificate-profile",
        object_dn=body.name,
    ) as entry:
        row = await pool.fetchrow(
            """
            INSERT INTO certificate_profile
                (name, description, purposes, validity_days, key_size, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (name) DO UPDATE SET
                description = excluded.description, purposes = excluded.purposes,
                validity_days = excluded.validity_days, key_size = excluded.key_size
            RETURNING *
            """,
            body.name, body.description, body.purposes,
            body.validity_days, body.key_size, session.principal,
        )
        profile = {**dict(row), "built_in": False}
        entry.after = profile
        return profile


@router.delete("/profiles", status_code=204, dependencies=[Depends(requires_domain_admin())])
async def delete_profile(
    name: Annotated[str, Query(pattern=r"^[a-z0-9][a-z0-9-]{1,30}$")],
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> Response:
    async with _audit_context(
        request, session, pool, "ca.profile.delete", object_type="certificate-profile",
        object_dn=name,
    ):
        # Certificates already issued from it keep the name they were issued
        # under; the profile only decides what a new one looks like.
        await pool.execute("DELETE FROM certificate_profile WHERE name = $1", name)
    return Response(status_code=204)


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
        result = await _publish(pool, settings, session.principal)
        entry.after = {
            "gpo": result["gpo_guid"],
            "linked_to": settings.base_dn,
            "certificates": result["published"],
        }
        return result


async def _publish(
    pool: asyncpg.Pool, settings: Settings, actor: str
) -> dict[str, Any]:
    """Put the domain's trust store into one policy object and link it.

    Called both by the Publish button and by creating the authority, because
    an authority nobody trusts is not much of an authority.
    """
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
            actor,
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
    return {
        "gpo_guid": str(guid),
        "display_name": TRUST_GPO_NAME,
        "published": [item["name"] for item in trusted],
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

    # Installing it means writing /etc and restarting a service, which the
    # sandboxed control plane cannot do to its own host. The agent on this
    # machine does it, the same way it installs a role. The certificate is
    # already staged on disk, so nothing private travels through the queue.
    async with pool.acquire() as conn:
        await tasks.enqueue(
            conn,
            node_fqdn=socket.getfqdn(),
            kind="console-certificate",
            payload={},
            subject=issued.serial,
            requested_by=session.principal,
        )

    return {
        "serial": issued.serial,
        "fingerprint": issued.fingerprint,
        "not_after": issued.not_after,
        "applied": False,
        "note": (
            "queued for the agent on this controller; the console restarts to "
            "pick up the new certificate"
        ),
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
