"""Monitoring: hosts, groups, probes, rules, channels, windows, dashboards.

Everything the Monitoring section of the console reads and writes. The
numbers themselves arrive through the agent endpoint in routes_agent; the
evaluation runs in monitor.evaluate_loop. This is the operator's side.
"""

from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from . import audit, monitor, objects, push
from .config import Settings, get_settings
from .security import client_ip, get_pool, require_admin, requires
from .sessions import Session

router = APIRouter(prefix="/api/v1/monitor", tags=["monitor"])

Id = Annotated[str, Query(min_length=36, max_length=36)]


def _row(row: asyncpg.Record) -> dict[str, Any]:
    out = dict(row)
    for key, value in out.items():
        if hasattr(value, "hex") and not isinstance(value, float | int | str | bytes):
            out[key] = str(value)
    if "channels" in out:
        out["channels"] = [str(item) for item in out["channels"]]
    if "layout" in out and isinstance(out["layout"], str):
        out["layout"] = json.loads(out["layout"])
    return out


# ------------------------------------------------------------------- read --


@router.get("/overview", dependencies=[Depends(requires("monitor.read"))])
async def overview(
    _: Session = Depends(require_admin), pool: asyncpg.Pool = Depends(get_pool)
) -> dict[str, Any]:
    """Whether the role is anywhere, and the numbers at a glance."""
    firing = await pool.fetch(
        "SELECT severity, count(*) AS n FROM monitor_alert WHERE state = 'firing' GROUP BY severity"
    )
    hosts = await monitor.host_summary(pool)
    return {
        "active": await monitor.active(pool),
        "probing_nodes": sorted(await monitor.probing_nodes(pool)),
        "hosts": len(hosts),
        "down": sum(1 for host in hosts if not host["up"]),
        "firing": {row["severity"]: row["n"] for row in firing},
        "metrics": monitor.KNOWN_METRICS,
    }


@router.get("/hosts", dependencies=[Depends(requires("monitor.read"))])
async def hosts(
    _: Session = Depends(require_admin), pool: asyncpg.Pool = Depends(get_pool)
) -> dict[str, Any]:
    return {"hosts": await monitor.host_summary(pool)}


@router.get("/series", dependencies=[Depends(requires("monitor.read"))])
async def read_series(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    metric: Annotated[str, Query(max_length=128)] = "cpu_percent",
    host: Annotated[str | None, Query(max_length=253)] = None,
    group: Annotated[str | None, Query(max_length=36)] = None,
    hours: Annotated[int, Query(ge=1, le=24 * monitor.RETENTION_DAYS)] = 6,
    points: Annotated[int, Query(ge=10, le=2000)] = 300,
) -> dict[str, Any]:
    if not monitor.METRIC_RE.match(metric):
        raise objects.ObjectError("not a metric name")
    now = datetime.now(UTC)
    scope: list[str] | None = None
    if host:
        scope = [host]
    elif group:
        scope = await monitor.hosts_in_scope(pool, "group", group)
    return {
        "metric": metric,
        "since": now - timedelta(hours=hours),
        "until": now,
        "series": await monitor.series_for_metric(
            pool, metric, scope, now - timedelta(hours=hours), now, points
        ),
    }


@router.get("/alerts", dependencies=[Depends(requires("monitor.read"))])
async def alerts(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    state: Annotated[str, Query(pattern="^(firing|resolved|all)$")] = "firing",
    host: Annotated[str | None, Query(max_length=253)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> dict[str, Any]:
    rows = await pool.fetch(
        """
        SELECT * FROM monitor_alert
        WHERE ($1 = 'all' OR state = $1) AND ($2::text IS NULL OR host = $2)
        ORDER BY (state = 'firing') DESC, (severity = 'critical') DESC, started_at DESC
        LIMIT $3
        """,
        state,
        host,
        limit,
    )
    return {"alerts": [_row(row) for row in rows]}


# ----------------------------------------------------------------- groups --


class GroupBody(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]
    description: Annotated[str, Field(max_length=500)] = ""
    members: Annotated[list[Annotated[str, Field(max_length=253)]], Field(max_length=500)] = []


@router.get("/groups", dependencies=[Depends(requires("monitor.read"))])
async def list_groups(
    _: Session = Depends(require_admin), pool: asyncpg.Pool = Depends(get_pool)
) -> dict[str, Any]:
    rows = await pool.fetch("SELECT * FROM monitor_group ORDER BY name")
    return {"groups": [_row(row) for row in rows]}


@router.post("/groups", status_code=201, dependencies=[Depends(requires("monitor.write"))])
async def create_group(
    body: GroupBody,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    members = sorted({m.strip().lower() for m in body.members if monitor.HOST_RE.match(m.strip())})
    try:
        row = await pool.fetchrow(
            """
            INSERT INTO monitor_group (name, description, members) VALUES ($1, $2, $3::text[])
            RETURNING *
            """,
            body.name,
            body.description,
            members,
        )
    except asyncpg.UniqueViolationError as exc:
        raise objects.ObjectError("a group with that name exists") from exc
    await _audit(pool, request, session, "monitor.group.create", body.name, {"members": members})
    return _row(row)


@router.put("/groups", dependencies=[Depends(requires("monitor.write"))])
async def update_group(
    body: GroupBody,
    request: Request,
    id: Id,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    members = sorted({m.strip().lower() for m in body.members if monitor.HOST_RE.match(m.strip())})
    row = await pool.fetchrow(
        """
        UPDATE monitor_group
        SET name = $2, description = $3, members = $4::text[], updated_at = now()
        WHERE id = $1::uuid RETURNING *
        """,
        id,
        body.name,
        body.description,
        members,
    )
    if row is None:
        raise objects.NotFound("no such group")
    await _audit(pool, request, session, "monitor.group.update", body.name, {"members": members})
    return _row(row)


@router.delete("/groups", status_code=204, dependencies=[Depends(requires("monitor.write"))])
async def delete_group(
    request: Request,
    id: Id,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    name = await pool.fetchval("DELETE FROM monitor_group WHERE id = $1::uuid RETURNING name", id)
    if name is None:
        raise objects.NotFound("no such group")
    await _audit(pool, request, session, "monitor.group.delete", name)


# ----------------------------------------------------------------- probes --


class ProbeBody(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]
    kind: Annotated[str, Field(pattern="^(ping|tcp|http)$")]
    target: Annotated[str, Field(min_length=1, max_length=512)]
    port: Annotated[int, Field(ge=0, le=65535)] = 0
    interval_seconds: Annotated[int, Field(ge=10, le=3600)] = 60
    enabled: bool = True


def _check_probe(body: ProbeBody) -> None:
    if body.kind == "http":
        if not body.target.startswith(("http://", "https://")):
            raise objects.ObjectError("an http probe's target is a URL")
    elif not monitor.HOST_RE.match(body.target):
        raise objects.ObjectError("the target must be a host name or address")
    if body.kind == "tcp" and not body.port:
        raise objects.ObjectError("a tcp probe needs a port")


@router.get("/probes", dependencies=[Depends(requires("monitor.read"))])
async def list_probes(
    _: Session = Depends(require_admin), pool: asyncpg.Pool = Depends(get_pool)
) -> dict[str, Any]:
    rows = await pool.fetch("SELECT * FROM monitor_probe ORDER BY name")
    return {"probes": [_row(row) for row in rows]}


@router.post("/probes", status_code=201, dependencies=[Depends(requires("monitor.write"))])
async def create_probe(
    body: ProbeBody,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    _check_probe(body)
    try:
        row = await pool.fetchrow(
            """
            INSERT INTO monitor_probe (name, kind, target, port, interval_seconds, enabled)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
            """,
            body.name,
            body.kind,
            body.target,
            body.port,
            body.interval_seconds,
            body.enabled,
        )
    except asyncpg.UniqueViolationError as exc:
        raise objects.ObjectError("a probe with that name exists") from exc
    await _audit(pool, request, session, "monitor.probe.create", body.name, body.model_dump())
    return _row(row)


@router.put("/probes", dependencies=[Depends(requires("monitor.write"))])
async def update_probe(
    body: ProbeBody,
    request: Request,
    id: Id,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    _check_probe(body)
    row = await pool.fetchrow(
        """
        UPDATE monitor_probe SET name = $2, kind = $3, target = $4, port = $5,
               interval_seconds = $6, enabled = $7
        WHERE id = $1::uuid RETURNING *
        """,
        id,
        body.name,
        body.kind,
        body.target,
        body.port,
        body.interval_seconds,
        body.enabled,
    )
    if row is None:
        raise objects.NotFound("no such probe")
    await _audit(pool, request, session, "monitor.probe.update", body.name, body.model_dump())
    return _row(row)


@router.delete("/probes", status_code=204, dependencies=[Depends(requires("monitor.write"))])
async def delete_probe(
    request: Request,
    id: Id,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    name = await pool.fetchval("DELETE FROM monitor_probe WHERE id = $1::uuid RETURNING name", id)
    if name is None:
        raise objects.NotFound("no such probe")
    await _audit(pool, request, session, "monitor.probe.delete", name)


# --------------------------------------------------------------- channels --


class ChannelBody(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]
    kind: Annotated[str, Field(pattern="^(ntfy|webhook)$")]
    url: Annotated[str, Field(max_length=1024)] = ""
    min_severity: Annotated[str, Field(pattern="^(warning|critical)$")] = "warning"


def _channel(row: asyncpg.Record, settings: Settings) -> dict[str, Any]:
    out = _row(row)
    if out["kind"] == "ntfy":
        out["available"] = push.configured(settings)
        out["subscribe_url"] = (
            push.subscribe_url(settings, out["topic"]) if push.configured(settings) else ""
        )
        out["server_url"] = push.server_url(settings) if push.configured(settings) else ""
    return out


@router.get("/channels", dependencies=[Depends(requires("monitor.read"))])
async def list_channels(
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    rows = await pool.fetch("SELECT * FROM monitor_channel ORDER BY name")
    return {"channels": [_channel(row, settings) for row in rows]}


@router.post("/channels", status_code=201, dependencies=[Depends(requires("monitor.write"))])
async def create_channel(
    body: ChannelBody,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    if body.kind == "webhook" and not body.url.startswith(("http://", "https://")):
        raise objects.ObjectError("a webhook needs an http(s) URL")
    # An ntfy channel is a topic of its own, as unguessable as a phone's.
    topic = push.TOPIC_PREFIX + "alerts-" + secrets.token_urlsafe(9) if body.kind == "ntfy" else ""
    try:
        row = await pool.fetchrow(
            """
            INSERT INTO monitor_channel (name, kind, topic, url, min_severity)
            VALUES ($1, $2, $3, $4, $5) RETURNING *
            """,
            body.name,
            body.kind,
            topic,
            body.url if body.kind == "webhook" else "",
            body.min_severity,
        )
    except asyncpg.UniqueViolationError as exc:
        raise objects.ObjectError("a channel with that name exists") from exc
    await _audit(pool, request, session, "monitor.channel.create", body.name, {"kind": body.kind})
    return _channel(row, settings)


@router.post("/channels/test", dependencies=[Depends(requires("monitor.write"))])
async def test_channel(
    id: Id,
    _: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    row = await pool.fetchrow("SELECT * FROM monitor_channel WHERE id = $1::uuid", id)
    if row is None:
        raise objects.NotFound("no such channel")
    try:
        await monitor.send_test(pool, settings, row)
    except push.PushError as exc:
        raise objects.ObjectError(str(exc)) from exc
    return {"sent": True}


@router.delete("/channels", status_code=204, dependencies=[Depends(requires("monitor.write"))])
async def delete_channel(
    request: Request,
    id: Id,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    name = await pool.fetchval("DELETE FROM monitor_channel WHERE id = $1::uuid RETURNING name", id)
    if name is None:
        raise objects.NotFound("no such channel")
    await _audit(pool, request, session, "monitor.channel.delete", name)


# ------------------------------------------------------------------ rules --


class RuleBody(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]
    description: Annotated[str, Field(max_length=500)] = ""
    metric: Annotated[str, Field(min_length=1, max_length=128)]
    op: Annotated[str, Field(pattern="^(gt|lt)$")] = "gt"
    threshold: float
    for_seconds: Annotated[int, Field(ge=0, le=86400)] = 300
    severity: Annotated[str, Field(pattern="^(warning|critical)$")] = "warning"
    scope_kind: Annotated[str, Field(pattern="^(all|group|host)$")] = "all"
    scope: Annotated[str, Field(max_length=253)] = ""
    channels: Annotated[
        list[Annotated[str, Field(min_length=36, max_length=36)]], Field(max_length=20)
    ] = []
    enabled: bool = True


def _check_rule(body: RuleBody) -> None:
    if not monitor.METRIC_RE.match(body.metric):
        raise objects.ObjectError("not a metric name")
    if body.scope_kind != "all" and not body.scope:
        raise objects.ObjectError("a group or host scope needs a group or host")


@router.get("/rules", dependencies=[Depends(requires("monitor.read"))])
async def list_rules(
    _: Session = Depends(require_admin), pool: asyncpg.Pool = Depends(get_pool)
) -> dict[str, Any]:
    rows = await pool.fetch("SELECT * FROM monitor_rule ORDER BY name")
    return {"rules": [_row(row) for row in rows]}


@router.post("/rules", status_code=201, dependencies=[Depends(requires("monitor.write"))])
async def create_rule(
    body: RuleBody,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    _check_rule(body)
    try:
        row = await pool.fetchrow(
            """
            INSERT INTO monitor_rule (name, description, metric, op, threshold, for_seconds,
                                      severity, scope_kind, scope, channels, enabled)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11) RETURNING *
            """,
            body.name,
            body.description,
            body.metric,
            body.op,
            body.threshold,
            body.for_seconds,
            body.severity,
            body.scope_kind,
            body.scope,
            body.channels,
            body.enabled,
        )
    except asyncpg.UniqueViolationError as exc:
        raise objects.ObjectError("a rule with that name exists") from exc
    await _audit(pool, request, session, "monitor.rule.create", body.name, body.model_dump())
    return _row(row)


@router.put("/rules", dependencies=[Depends(requires("monitor.write"))])
async def update_rule(
    body: RuleBody,
    request: Request,
    id: Id,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    _check_rule(body)
    row = await pool.fetchrow(
        """
        UPDATE monitor_rule SET name = $2, description = $3, metric = $4, op = $5, threshold = $6,
               for_seconds = $7, severity = $8, scope_kind = $9, scope = $10,
               channels = $11::uuid[], enabled = $12, updated_at = now()
        WHERE id = $1::uuid RETURNING *
        """,
        id,
        body.name,
        body.description,
        body.metric,
        body.op,
        body.threshold,
        body.for_seconds,
        body.severity,
        body.scope_kind,
        body.scope,
        body.channels,
        body.enabled,
    )
    if row is None:
        raise objects.NotFound("no such rule")
    await _audit(pool, request, session, "monitor.rule.update", body.name, body.model_dump())
    return _row(row)


@router.delete("/rules", status_code=204, dependencies=[Depends(requires("monitor.write"))])
async def delete_rule(
    request: Request,
    id: Id,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    name = await pool.fetchval("DELETE FROM monitor_rule WHERE id = $1::uuid RETURNING name", id)
    if name is None:
        raise objects.NotFound("no such rule")
    await _audit(pool, request, session, "monitor.rule.delete", name)


# ------------------------------------------------------------ maintenance --


class MaintenanceBody(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]
    scope_kind: Annotated[str, Field(pattern="^(all|group|host)$")] = "all"
    scope: Annotated[str, Field(max_length=253)] = ""
    starts_at: datetime
    ends_at: datetime
    note: Annotated[str, Field(max_length=500)] = ""


@router.get("/maintenance", dependencies=[Depends(requires("monitor.read"))])
async def list_maintenance(
    _: Session = Depends(require_admin), pool: asyncpg.Pool = Depends(get_pool)
) -> dict[str, Any]:
    rows = await pool.fetch(
        "SELECT * FROM monitor_maintenance"
        " WHERE ends_at > now() - interval '30 days' ORDER BY starts_at DESC"
    )
    return {"windows": [_row(row) for row in rows]}


@router.post("/maintenance", status_code=201, dependencies=[Depends(requires("monitor.write"))])
async def create_maintenance(
    body: MaintenanceBody,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    if body.ends_at <= body.starts_at:
        raise objects.ObjectError("the window must end after it starts")
    if body.scope_kind != "all" and not body.scope:
        raise objects.ObjectError("a group or host scope needs a group or host")
    row = await pool.fetchrow(
        """
        INSERT INTO monitor_maintenance
            (name, scope_kind, scope, starts_at, ends_at, note, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
        """,
        body.name,
        body.scope_kind,
        body.scope,
        body.starts_at,
        body.ends_at,
        body.note,
        session.principal,
    )
    await _audit(
        pool,
        request,
        session,
        "monitor.maintenance.create",
        body.name,
        {"from": body.starts_at.isoformat(), "to": body.ends_at.isoformat()},
    )
    return _row(row)


@router.delete("/maintenance", status_code=204, dependencies=[Depends(requires("monitor.write"))])
async def delete_maintenance(
    request: Request,
    id: Id,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    name = await pool.fetchval(
        "DELETE FROM monitor_maintenance WHERE id = $1::uuid RETURNING name", id
    )
    if name is None:
        raise objects.NotFound("no such window")
    await _audit(pool, request, session, "monitor.maintenance.delete", name)


# ------------------------------------------------------------- dashboards --


class DashboardBody(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]
    layout: dict[str, Any] = Field(default_factory=lambda: {"widgets": []})
    is_default: bool = False
    channel_id: Annotated[str, Field(min_length=36, max_length=36)] | None = None


@router.get("/dashboards", dependencies=[Depends(requires("monitor.read"))])
async def list_dashboards(
    _: Session = Depends(require_admin), pool: asyncpg.Pool = Depends(get_pool)
) -> dict[str, Any]:
    rows = await pool.fetch("SELECT * FROM monitor_dashboard ORDER BY is_default DESC, name")
    return {"dashboards": [_row(row) for row in rows]}


@router.get("/dashboard/data", dependencies=[Depends(requires("monitor.read"))])
async def dashboard_data(
    id: Id, _: Session = Depends(require_admin), pool: asyncpg.Pool = Depends(get_pool)
) -> dict[str, Any]:
    row = await pool.fetchrow("SELECT * FROM monitor_dashboard WHERE id = $1::uuid", id)
    if row is None:
        raise objects.NotFound("no such dashboard")
    dashboard = _row(row)
    return {"dashboard": dashboard, "data": await monitor.render(pool, dashboard["layout"])}


@router.post("/dashboards", status_code=201, dependencies=[Depends(requires("monitor.write"))])
async def create_dashboard(
    body: DashboardBody,
    request: Request,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    try:
        layout = monitor.validate_layout(body.layout)
    except monitor.MonitorError as exc:
        raise objects.ObjectError(str(exc)) from exc
    async with pool.acquire() as conn:
        if body.is_default:
            await conn.execute("UPDATE monitor_dashboard SET is_default = false")
        try:
            row = await conn.fetchrow(
                """
                INSERT INTO monitor_dashboard (name, layout, is_default, channel_id)
                VALUES ($1, $2::jsonb, $3, $4::uuid) RETURNING *
                """,
                body.name,
                json.dumps(layout),
                body.is_default,
                body.channel_id,
            )
        except asyncpg.UniqueViolationError as exc:
            raise objects.ObjectError("a dashboard with that name exists") from exc
    await _audit(pool, request, session, "monitor.dashboard.create", body.name)
    return _row(row)


@router.put("/dashboards", dependencies=[Depends(requires("monitor.write"))])
async def update_dashboard(
    body: DashboardBody,
    request: Request,
    id: Id,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    try:
        layout = monitor.validate_layout(body.layout)
    except monitor.MonitorError as exc:
        raise objects.ObjectError(str(exc)) from exc
    async with pool.acquire() as conn:
        if body.is_default:
            await conn.execute("UPDATE monitor_dashboard SET is_default = false")
        row = await conn.fetchrow(
            """
            UPDATE monitor_dashboard
            SET name = $2, layout = $3::jsonb, is_default = $4, channel_id = $5::uuid,
                updated_at = now()
            WHERE id = $1::uuid RETURNING *
            """,
            id,
            body.name,
            json.dumps(layout),
            body.is_default,
            body.channel_id,
        )
    if row is None:
        raise objects.NotFound("no such dashboard")
    await _audit(pool, request, session, "monitor.dashboard.update", body.name)
    return _row(row)


@router.post("/dashboards/share", dependencies=[Depends(requires("monitor.write"))])
async def share_dashboard(
    request: Request,
    id: Id,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
    revoke: bool = False,
) -> dict[str, Any]:
    """A public link for a screen on a wall, or the end of one.

    The token is as long as a session's and shows only what the dashboard
    shows — numbers about machines, never a name of a person or a command.
    Clearing it is what revoking means; a link that was on a screen stops
    working the moment it is cleared.
    """
    token = None if revoke else secrets.token_urlsafe(32)
    name = await pool.fetchval(
        "UPDATE monitor_dashboard SET public_token = $2 WHERE id = $1::uuid RETURNING name",
        id,
        token,
    )
    if name is None:
        raise objects.NotFound("no such dashboard")
    await _audit(
        pool,
        request,
        session,
        "monitor.dashboard.unshare" if revoke else "monitor.dashboard.share",
        name,
    )
    return {"public_token": token}


@router.delete("/dashboards", status_code=204, dependencies=[Depends(requires("monitor.write"))])
async def delete_dashboard(
    request: Request,
    id: Id,
    session: Session = Depends(require_admin),
    pool: asyncpg.Pool = Depends(get_pool),
) -> None:
    name = await pool.fetchval(
        "DELETE FROM monitor_dashboard WHERE id = $1::uuid RETURNING name", id
    )
    if name is None:
        raise objects.NotFound("no such dashboard")
    await _audit(pool, request, session, "monitor.dashboard.delete", name)


@router.get("/public/{token}")
async def public_dashboard(
    token: Annotated[str, Field(min_length=20, max_length=64)],
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """A shared dashboard, for whoever has its link.

    Public on purpose: a screen on a wall has no session. What it answers
    is the dashboard's own layout and the numbers it draws — nothing about
    people, nothing anyone can act on — and only for a token that was
    deliberately created for it.
    """
    row = await pool.fetchrow("SELECT * FROM monitor_dashboard WHERE public_token = $1", token)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such dashboard")
    dashboard = _row(row)
    dashboard.pop("public_token", None)
    dashboard.pop("channel_id", None)
    return {"dashboard": dashboard, "data": await monitor.render(pool, dashboard["layout"])}


# ------------------------------------------------------------------ audit --


async def _audit(
    pool: asyncpg.Pool,
    request: Request,
    session: Session,
    action: str,
    name: str,
    after: dict[str, Any] | None = None,
) -> None:
    async with pool.acquire() as conn:
        await audit.record(
            conn,
            actor=session.principal,
            actor_sid=session.principal_sid,
            source_ip=client_ip(request),
            action=action,
            outcome="success",
            object_type="monitor",
            object_dn=name,
            after=after,
        )
