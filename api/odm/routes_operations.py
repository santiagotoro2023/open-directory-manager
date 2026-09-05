"""Replication, backups and the health dashboard (CLAUDE.md §4)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
from datetime import UTC, datetime
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import (
    agents,
    audit,
    backup,
    baseline,
    ca,
    dns,
    domainexport,
    kea,
    objects,
    replication,
    routes_password,
    tasks,
)
from .config import Settings, get_settings
from .routes_directory import _audit_context, _bound
from .security import get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1", tags=["operations"])


class ReplicateRequest(BaseModel):
    destination: Annotated[str, Field(min_length=1, max_length=253)]
    source: Annotated[str, Field(min_length=1, max_length=253)]
    naming_context: Annotated[str, Field(min_length=3, max_length=1024)]


# ----------------------------------------------------------- replication ---


@router.get("/replication", dependencies=[Depends(requires("replication.read"))])
async def replication_status(
    settings: Settings = Depends(get_settings),
    server: Annotated[str | None, Query(max_length=253)] = None,
) -> dict[str, Any]:
    """Domain controllers and the state of inbound replication."""
    async with _bound(settings, write=False) as conn:
        dcs = await run_in_threadpool(replication.controllers, conn, settings)
    if len(dcs) < 2:
        return {"controllers": dcs, "healthy": True, "inbound": [], "single": True,
                "server": server or ""}
    status = await run_in_threadpool(replication.status, settings, server)
    return {"controllers": dcs, **status}


@router.post("/replication/replicate", dependencies=[Depends(requires("replication.replicate"))])
async def force_replication(
    body: ReplicateRequest,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Force one replication run between two controllers."""
    async with _audit_context(
        request,
        session,
        pool,
        "replication.replicate",
        object_type="replication",
        object_dn=body.naming_context,
    ) as entry:
        output = await run_in_threadpool(
            replication.replicate, settings, body.destination, body.source, body.naming_context
        )
        entry.after = {"destination": body.destination, "source": body.source}
        return {"output": output.strip()[-2000:]}


# --------------------------------------------------------------- backups ---


@router.get("/backups", dependencies=[Depends(requires("backup.read"))])
async def list_backups(
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    rows = await pool.fetch(
        "SELECT * FROM domain_backup ORDER BY started_at DESC LIMIT 100"
    )
    return {
        "configured": backup.configured(settings),
        "directory": str(settings.backup_dir) if settings.backup_dir else None,
        "interval_hours": settings.backup_interval_hours,
        "keep": settings.backup_keep,
        "history": [{**dict(row), "id": str(row["id"])} for row in rows],
        "archives": await run_in_threadpool(backup.archives, settings),
    }


@router.post("/backups", status_code=202, dependencies=[Depends(requires("backup.write"))])
async def take_backup(
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Start a backup and return immediately; poll /backups for the outcome."""
    if not backup.configured(settings):
        raise objects.ObjectError("no backup directory configured (ODM_BACKUP_DIR is unset)")
    row = await pool.fetchrow(
        "INSERT INTO domain_backup (path, taken_by) VALUES ($1, $2) RETURNING id",
        f"pending:{session.principal}:{asyncio.get_running_loop().time()}",
        session.principal,
    )
    # Queued for this controller's own agent, which is root there. The
    # control plane is not, and an online backup would need directory rights
    # its account deliberately does not hold (CLAUDE.md §6).
    async with pool.acquire() as conn:
        await tasks.enqueue(
            conn,
            node_fqdn=socket.getfqdn(),
            kind="domain-backup",
            payload={"target_dir": str(backup.directory(settings))},
            subject=str(row["id"]),
            requested_by=session.principal,
        )
    return {"id": str(row["id"]), "state": "running"}


async def _run_backup(
    pool: asyncpg.Pool, settings: Settings, backup_id: str, actor: str
) -> None:
    try:
        result = await run_in_threadpool(backup.take, settings)
    except Exception as exc:  # recorded, never raised into a background task
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE domain_backup
                SET state = 'failed', finished_at = now(), detail = $2
                WHERE id = $1::uuid
                """,
                backup_id,
                str(exc)[:2000],
            )
            await audit.record(
                conn,
                actor=actor,
                action="backup.take",
                outcome="failure",
                object_type="backup",
                detail=str(exc)[:500],
            )
        return

    removed = await run_in_threadpool(backup.prune, settings, settings.backup_keep)
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE domain_backup
            SET state = 'complete', finished_at = now(), path = $2, size_bytes = $3
            WHERE id = $1::uuid
            """,
            backup_id,
            result["path"],
            result["size_bytes"],
        )
        if removed:
            await conn.execute(
                "UPDATE domain_backup SET state = 'removed' WHERE path = ANY($1::text[])",
                removed,
            )
        await audit.record(
            conn,
            actor=actor,
            action="backup.take",
            outcome="success",
            object_type="backup",
            object_dn=result["path"],
            detail=f"{result['size_bytes']} bytes; pruned {len(removed)}",
        )


async def backup_loop(pool: asyncpg.Pool, settings: Settings) -> None:
    """Scheduled backups, started with the application."""
    if not backup.configured(settings):
        return
    interval = max(settings.backup_interval_hours, 1) * 3600
    while True:
        await asyncio.sleep(interval)
        with contextlib.suppress(Exception):
            row = await pool.fetchrow(
                "INSERT INTO domain_backup (path, taken_by) VALUES ($1, 'system') RETURNING id",
                f"pending:system:{asyncio.get_running_loop().time()}",
            )
            await _run_backup(pool, settings, str(row["id"]), "system")


# ---------------------------------------------------------------- health ---


@router.get("/health", dependencies=[Depends(requires("health.read"))])
async def health(
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """One view of whether the domain is well.

    Every section degrades independently: a subsystem that is not installed,
    or not reachable, reports that rather than failing the whole dashboard.
    """
    report: dict[str, Any] = {"domain": settings.domain}

    report["directory"] = await _section(_directory_health, settings)
    # A domain with one controller has nothing to replicate, and asking anyway
    # produced a red banner on the dashboard of every new install. The count
    # comes from the directory read just above, so this costs nothing.
    if report["directory"].get("controllers", 0) < 2:
        report["replication"] = {"available": True, "healthy": True, "inbound": [],
                                 "single": True}
    else:
        report["replication"] = await _section(
            lambda: run_in_threadpool(replication.status, settings)
        )
    report["dhcp"] = (
        {"configured": False}
        if not kea.configured(settings)
        else await _section(
            lambda: run_in_threadpool(
                lambda: {"statistics": kea.statistics(settings), "ha": kea.ha_status(settings)}
            )
        )
    )
    report["certificates"] = (
        {"initialised": False}
        if not ca.initialised(settings)
        else await _section(lambda: _certificate_health(pool, settings))
    )
    report["agents"] = await _agent_health(pool, settings)
    report["backups"] = await _backup_health(pool, settings)
    return report


async def _section(builder, *args) -> dict[str, Any]:
    try:
        result = builder(*args) if args else builder()
        return await result if asyncio.iscoroutine(result) else result
    except Exception as exc:
        return {"available": False, "detail": str(exc)[:300]}


async def _directory_health(settings: Settings) -> dict[str, Any]:
    async with _bound(settings, write=False) as conn:
        dcs = await run_in_threadpool(replication.controllers, conn, settings)
    return {"available": True, "controllers": len(dcs), "names": [dc["name"] for dc in dcs]}


async def _certificate_health(pool: asyncpg.Pool, settings: Settings) -> dict[str, Any]:
    described = ca.describe(settings)
    described["expiring_soon"] = await pool.fetchval(
        """
        SELECT count(*) FROM ca_certificate
        WHERE revoked_at IS NULL AND not_after < now() + interval '30 days'
        """
    )
    return described


async def _agent_health(pool: asyncpg.Pool, settings: Settings) -> dict[str, Any]:
    stale_after = max(settings.agent_refresh_minutes * 3, 60)
    counts = await agents.freshness(pool, stale_after)
    failures = await pool.fetchval(
        """
        SELECT coalesce(sum(failures), 0) FROM (
            SELECT DISTINCT ON (computer_dn) computer_dn, failures
            FROM agent_report ORDER BY computer_dn, reported_at DESC
        ) latest
        """
    )
    # A count of failures nobody can turn into a name is a number to worry
    # about and nothing to do about it. The settings themselves come back with
    # it, so the console can say which machine failed at what and why.
    failing = await pool.fetch(
        """
        SELECT latest.hostname, item->>'setting' AS setting, item->>'reason' AS reason
        FROM (
            SELECT DISTINCT ON (computer_dn) hostname, results
            FROM agent_report ORDER BY computer_dn, reported_at DESC
        ) latest, LATERAL jsonb_array_elements(latest.results) item
        WHERE item->>'status' = 'failed'
        ORDER BY latest.hostname
        LIMIT 50
        """
    )
    return {
        **counts,
        "failing_settings": failures,
        "failing": [dict(entry) for entry in failing],
        "stale_after_minutes": stale_after,
    }


async def _backup_health(pool: asyncpg.Pool, settings: Settings) -> dict[str, Any]:
    if not backup.configured(settings):
        return {"configured": False}
    row = await pool.fetchrow(
        """
        SELECT started_at, finished_at, state, size_bytes
        FROM domain_backup WHERE state = 'complete'
        ORDER BY started_at DESC LIMIT 1
        """
    )
    return {
        "configured": True,
        "interval_hours": settings.backup_interval_hours,
        "last": dict(row) if row else None,
    }


# ------------------------------------------------------------ export ------

# How many of each kind of object one export carries. A domain larger than
# this is one whose export belongs in a scheduled job rather than a request
# somebody is waiting on, and silently truncating would be worse than saying
# so.
EXPORT_LIMIT = 20_000


def _version() -> str:
    try:
        from importlib.metadata import version

        return version("odm")
    except Exception:  # pragma: no cover - a source checkout without metadata
        return "unknown"


@router.get("/domain/export", dependencies=[Depends(requires("domain.export"))])
async def export_domain(
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Everything this domain is configured to be, as one file.

    The directory's objects, the DNS zones beside them, and ODM's own record
    of everything built on top: every policy object and its settings, every
    share, printer, scope, collection, role and delegation. Enough to rebuild
    the domain somewhere that has never seen this one, and enough for somebody
    reading it to see every setting without access to the running system.

    Credentials are not in it — see domainexport for which, and why.
    """
    directory: dict[str, list[dict[str, Any]]] = {}
    async with _bound(settings, write=False) as conn:
        for kind, key in (
            ("ou", "organizational_units"),
            ("group", "groups"),
            ("user", "users"),
            ("computer", "computers"),
        ):
            found, truncated = await run_in_threadpool(
                objects.search,
                conn,
                settings,
                object_type=kind,
                container=None,
                query=None,
                scope="subtree",
                limit=EXPORT_LIMIT,
            )
            if truncated:
                raise objects.ObjectError(
                    f"this domain has more than {EXPORT_LIMIT:,} {key.replace('_', ' ')}; "
                    "an export that large belongs in a domain backup instead"
                )
            directory[key] = [domainexport.snapshot_of(entry) for entry in found]

    zones: list[dict[str, Any]] = []
    if dns.available():
        for zone in await run_in_threadpool(dns.list_zones, settings):
            name = str(zone.get("name", ""))
            if not name or name.startswith("_msdcs"):
                continue
            try:
                records = [
                    record.as_json()
                    for record in await run_in_threadpool(dns.list_records, settings, name)
                ]
            except dns.DnsError:
                continue
            zones.append({"name": name, "records": records})

    async with pool.acquire() as conn:
        database = await domainexport.database_section(conn)

    document = {
        "odm_export": domainexport.EXPORT_FORMAT,
        "taken_at": datetime.now(UTC).isoformat(),
        "version": _version(),
        "domain": {
            "realm": settings.realm,
            "domain": settings.domain,
            "base_dn": settings.base_dn,
        },
        "withheld": domainexport.withheld_in(database),
        "directory": directory,
        "dns": {"zones": zones},
        "database": database,
    }

    async with pool.acquire() as conn:
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=request.client.host if request.client else "",
            action="domain.export",
            outcome="success",
            object_type="domain",
            object_dn=settings.base_dn,
            detail=(
                f"{len(directory['users'])} users, {len(directory['groups'])} groups, "
                f"{len(zones)} DNS zones"
            ),
        )

    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M")
    return Response(
        content=domainexport.as_json(document),
        media_type="application/json",
        headers={
            "Content-Disposition":
                f'attachment; filename="odm-{settings.domain}-{stamp}.json"',
        },
    )


@router.post("/domain/import", dependencies=[Depends(requires("domain.import"))])
async def import_domain(
    request: Request,
    apply: Annotated[bool, Query()] = False,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Make this domain the one the file describes.

    Nothing happens without apply: the same call without it reads the file and
    answers with what importing it would bring in. An import replaces this
    domain's configuration wholesale, and nobody should agree to that without
    first being told the size of what they are agreeing to.
    """
    # The file itself as the body, rather than a multipart upload: an export
    # is JSON, the console has it as text, and the installer sends it with
    # curl. A form encoding would only be one more thing to get right.
    raw = await request.body()
    try:
        document = domainexport.check(json.loads(raw))
    except ValueError as exc:
        raise objects.ObjectError(f"this file is not readable JSON: {exc}") from exc
    except domainexport.ImportError_ as exc:
        raise objects.ObjectError(str(exc)) from exc

    summary = domainexport.summarise(document)
    if not apply:
        return {"applied": False, "summary": summary}

    result = await _apply_import(document, settings, pool, session.principal)
    async with pool.acquire() as conn:
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=request.client.host if request.client else "",
            action="domain.import",
            outcome="success",
            object_type="domain",
            object_dn=settings.base_dn,
            before={"summary": summary},
            after=result,
        )
    return {"applied": True, "summary": summary, "result": result}


async def _apply_import(
    document: dict[str, Any],
    settings: Settings,
    pool: asyncpg.Pool,
    actor: str,
) -> dict[str, Any]:
    """Put the file back, directory first and ODM's own store after it.

    In that order because the second half names the first: a GPO link points
    at an OU, a share's access list names a group, a collection names the
    people who may connect to it. Nothing is rolled back on a failure —
    what did land is reported, and the import is safe to run again.
    """
    source_base = str((document.get("domain") or {}).get("base_dn") or "")
    target_base = settings.base_dn
    directory = document.get("directory") or {}
    created: dict[str, int] = {}
    problems: list[str] = []

    def place(snapshot: dict[str, Any]) -> dict[str, Any]:
        moved = dict(snapshot)
        moved["object_dn"] = domainexport.rewrite_dn(
            str(snapshot["object_dn"]), source_base, target_base
        )
        moved["parent_dn"] = domainexport.rewrite_dn(
            str(snapshot.get("parent_dn") or ""), source_base, target_base
        )
        # Both directions of membership are re-added in a second pass, once
        # every group in the file exists: a group nested in another cannot
        # join it before it is there, and nothing in a file says which came
        # first.
        moved["memberships"] = []
        moved["members"] = []
        return moved

    async with _bound(settings, write=True) as conn:
        for key in ("organizational_units", "groups", "users", "computers"):
            snapshots = [place(entry) for entry in directory.get(key) or []]
            # Parents before children, so an OU three deep is not created
            # before the one it lives in.
            snapshots.sort(key=lambda entry: domainexport.depth(entry["object_dn"]))
            done = 0
            for snapshot in snapshots:
                try:
                    await run_in_threadpool(objects.restore, conn, settings, snapshot, None)
                    done += 1
                except (objects.ObjectError, objects.NotFound) as exc:
                    problems.append(f"{snapshot['object_dn']}: {exc}")
            created[key] = done

        # And now the memberships, with every group in place.
        rejoined = 0
        for key in ("groups", "users", "computers"):
            for entry in directory.get(key) or []:
                dn = domainexport.rewrite_dn(str(entry["object_dn"]), source_base, target_base)
                memberships = [
                    domainexport.rewrite_dn(str(group), source_base, target_base)
                    for group in entry.get("memberships") or []
                ]
                members = [
                    domainexport.rewrite_dn(str(member), source_base, target_base)
                    for member in entry.get("members") or []
                ]
                if not memberships and not members:
                    continue
                try:
                    # The recycle bin's own re-join, because putting an object
                    # back into the groups it was in is the same operation
                    # here as it is there.
                    await run_in_threadpool(
                        objects._rejoin_groups, conn, settings, dn,
                        {"memberships": memberships, "members": members},
                    )
                    rejoined += 1
                except objects.ObjectError as exc:
                    problems.append(f"{dn} memberships: {exc}")
        created["memberships"] = rejoined

    zones = 0
    records = 0
    if dns.available():
        existing = {
            str(zone.get("name", "")).lower()
            for zone in await run_in_threadpool(dns.list_zones, settings)
        }
        for zone in (document.get("dns") or {}).get("zones") or []:
            name = str(zone.get("name", ""))
            if not name:
                continue
            if name.lower() not in existing:
                try:
                    await run_in_threadpool(dns.create_zone, settings, name)
                    zones += 1
                except dns.DnsError as exc:
                    problems.append(f"DNS zone {name}: {exc}")
                    continue
            here = {
                (r.name, r.type, r.data)
                for r in await run_in_threadpool(dns.list_records, settings, name)
            }
            for record in domainexport.importable_records(name, zone.get("records") or []):
                if (record["name"], record["type"], record["data"]) in here:
                    continue
                try:
                    await run_in_threadpool(
                        dns.add_record, settings, name,
                        record["name"], record["type"], record["data"],
                    )
                    records += 1
                except dns.DnsError as exc:
                    problems.append(f"{record['name']}.{name} {record['type']}: {exc}")

    tables: dict[str, int] = {}
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Constraints between ODM's own tables are checked at the end of
            # the transaction rather than after each table, so the order the
            # export happened to list them in does not matter.
            await conn.execute("SET CONSTRAINTS ALL DEFERRED")
            for table, rows in (document.get("database") or {}).items():
                if table in domainexport.VOLATILE_TABLES:
                    continue
                try:
                    tables[table] = await domainexport.replace_table(conn, table, rows)
                except asyncpg.PostgresError as exc:
                    raise objects.ObjectError(
                        f"restoring {table}: {exc}. Nothing in ODM's own store was changed; "
                        "the directory objects above were."
                    ) from exc

    return {
        "directory": created,
        "dns": {"zones": zones, "records": records},
        "tables": {name: count for name, count in tables.items() if count},
        "problems": problems[:200],
    }


# ------------------------------------------------------ security baseline ---

# How long an enabled account may go unused before it is worth asking about.
STALE_ACCOUNT_DAYS = 90
# How long a machine may go without reporting before its policy is stale.
STALE_AGENT_HOURS = 24


@router.get("/domain/baseline", dependencies=[Depends(requires("domain.baseline"))])
async def security_baseline(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """The domain measured against a security checklist.

    Every check reads something ODM already holds and answers one question an
    auditor asks. Nothing here changes anything, and each finding says where
    in the console it is fixed — a report nobody can act on is a complaint.
    """
    now = baseline.now_utc()
    checks: list[baseline.Check] = []

    async with _bound(settings, write=False) as conn:
        users, _ = await run_in_threadpool(
            objects.search,
            conn,
            settings,
            object_type="user",
            container=None,
            query=None,
            scope="subtree",
            limit=5000,
        )
        admins = await run_in_threadpool(
            objects.account_names_in, conn, settings, settings.admin_group
        )
        try:
            policy_rows = await run_in_threadpool(routes_password.read_policy, settings)
        except Exception:  # noqa: BLE001 - a domain whose policy cannot be read is a finding
            policy_rows = {}

    described = [
        {
            "name": str(user.get("sAMAccountName") or user.get("cn") or ""),
            "disabled": bool(int(user.get("userAccountControl") or 0) & 0x0002),
            "password_never_expires": bool(int(user.get("userAccountControl") or 0) & 0x10000),
            "last_logon": _as_datetime(user.get("lastLogonTimestamp")),
        }
        for user in users
    ]

    checks.append(baseline.stale_accounts(described, STALE_ACCOUNT_DAYS, now))
    checks.append(baseline.passwords_never_expire(described))
    checks.append(baseline.privileged_accounts(sorted(admins)))
    checks.append(baseline.password_policy(_normalised_policy(policy_rows)))

    enrolled = {
        str(row["principal"]).split("@")[0].lower()
        for row in await pool.fetch(
            "SELECT principal FROM totp_enrolment WHERE confirmed_at IS NOT NULL"
        )
    }
    checks.append(baseline.second_factor(sorted(admins), enrolled))

    machines = await pool.fetch("SELECT hostname, volumes, reported_at FROM computer_fact")
    stale = sum(
        1
        for row in machines
        if row["reported_at"] is None
        or (now - row["reported_at"]).total_seconds() > STALE_AGENT_HOURS * 3600
    )
    checks.append(baseline.agents_reporting(len(machines), stale, STALE_AGENT_HOURS))
    checks.append(
        baseline.encryption(
            [
                {"hostname": row["hostname"], "volumes": json.loads(row["volumes"] or "[]")}
                for row in machines
            ]
        )
    )

    last_backup = await pool.fetchval(
        "SELECT max(finished_at) FROM domain_backup WHERE state = 'complete'"
    )
    checks.append(baseline.backups(last_backup, now))

    expiring = await pool.fetch(
        """
        SELECT subject FROM ca_certificate
        WHERE revoked_at IS NULL AND not_after < now() + interval '30 days'
          AND not_after > now()
        """
    )
    checks.append(baseline.certificate_expiry([dict(row) for row in expiring]))

    assignments = await pool.fetch(
        "SELECT principal_name, role_name, scope_dn FROM rbac_assignment"
    )

    checks.append(
        baseline.delegation(
            [
                {
                    "principal": row["principal_name"],
                    "role_name": row["role_name"],
                    "scope_dn": row["scope_dn"],
                }
                for row in assignments
            ]
        )
    )

    order = {name: index for index, name in enumerate(baseline.SEVERITIES)}
    checks.sort(key=lambda check: (order.get(check.severity, 99), check.title))
    return {
        "taken_at": now,
        "score": baseline.score(checks),
        "checks": [check.as_json() for check in checks],
    }


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def _normalised_policy(raw: dict[str, Any]) -> dict[str, Any] | None:
    """samba-tool's labels, as the checks want to read them."""
    if not raw:
        return None

    def number(label: str) -> int:
        for key, value in raw.items():
            if label.lower() in key.lower():
                digits = "".join(character for character in str(value) if character.isdigit())
                return int(digits) if digits else 0
        return 0

    complexity = ""
    for key, value in raw.items():
        if "complexity" in key.lower():
            complexity = str(value).strip().lower()
    return {
        "min_length": number("Minimum password length"),
        "complexity": complexity in ("on", "true", "yes"),
        "lockout_threshold": number("Account lockout threshold"),
    }
