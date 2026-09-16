"""Monitoring: what the machines measure, what is watched, who is told.

Every agent reports a handful of numbers a minute about its own machine once
the monitoring role exists anywhere; a machine carrying the role also probes
what has no agent. The numbers land in metric_sample. This module is the
rest: reading series back for a chart, evaluating the rules every half
minute, opening and resolving alerts, honouring maintenance windows, and
telling the channels — an ntfy topic a phone subscribes to, or a webhook.

Deliberately plain. This is not a time-series database and does not pretend
to be one: a fortnight of one-minute samples from a domain of machines is
a few million rows, which PostgreSQL reads back in the time a page takes to
draw, and the questions asked of it are "is it over the line, and for how
long" and "draw the last six hours".
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from fastapi.concurrency import run_in_threadpool

from . import push
from .config import Settings, get_settings

log = logging.getLogger("odm.monitor")

# How long samples are kept. Long enough to look back a fortnight on a chart;
# short enough that the table stays a working set.
RETENTION_DAYS = 14
# How often the rules are looked at.
EVALUATE_SECONDS = 30
# The agent's default reporting interval, and what "not reporting" is
# measured against.
DEFAULT_INTERVAL = 60

METRIC_RE = re.compile(r"^[a-z_]+(:[A-Za-z0-9._/@-]{0,120})?$")
HOST_RE = re.compile(r"^[A-Za-z0-9._:-]{1,253}$")

# Metrics the agent reports, for the console's pickers. A metric ending in
# ':' is a family with one series per suffix (one per filesystem, say).
KNOWN_METRICS: list[dict[str, str]] = [
    {"metric": "cpu_percent", "label": "Processor busy %", "unit": "%"},
    {"metric": "load1", "label": "Load average (1 min)", "unit": ""},
    {"metric": "mem_percent", "label": "Memory used %", "unit": "%"},
    {"metric": "swap_percent", "label": "Swap used %", "unit": "%"},
    {"metric": "disk_percent:", "label": "Filesystem used % (per mount)", "unit": "%"},
    {"metric": "disk_free_bytes:", "label": "Filesystem free (per mount)", "unit": "bytes"},
    {"metric": "net_rx_bytes_per_s", "label": "Network received", "unit": "bytes/s"},
    {"metric": "net_tx_bytes_per_s", "label": "Network sent", "unit": "bytes/s"},
    {"metric": "temp_c", "label": "Hottest sensor", "unit": "°C"},
    {"metric": "uptime_seconds", "label": "Uptime", "unit": "s"},
    {"metric": "processes", "label": "Processes", "unit": ""},
    {"metric": "agent_up", "label": "Reporting", "unit": ""},
    {"metric": "probe_up:", "label": "Probe answered (per check)", "unit": ""},
    {"metric": "probe_latency_ms:", "label": "Probe latency (per check)", "unit": "ms"},
]


class MonitorError(Exception):
    """A request that cannot be honoured, said in a sentence."""


# ------------------------------------------------------------------ scope --


async def hosts_in_scope(pool: Any, scope_kind: str, scope: str) -> list[str] | None:
    """The host names a scope covers; None means every host."""
    if scope_kind == "all":
        return None
    if scope_kind == "host":
        return [scope]
    row = await pool.fetchrow("SELECT members FROM monitor_group WHERE id::text = $1", scope)
    return list(row["members"]) if row else []


async def known_hosts(pool: Any, since_minutes: int = 60 * 24 * 14) -> list[str]:
    rows = await pool.fetch(
        """
        SELECT DISTINCT host FROM metric_sample
        WHERE at > now() - ($1 || ' minutes')::interval
        ORDER BY host
        """,
        str(since_minutes),
    )
    return [row["host"] for row in rows]


# ----------------------------------------------------------------- series --


async def series(
    pool: Any, host: str, metric: str, since: datetime, until: datetime, points: int = 300
) -> list[list[float]]:
    """One series, bucketed to at most `points` values of [epoch, mean]."""
    seconds = max(1, int((until - since).total_seconds()))
    step = max(1, seconds // max(1, points))
    rows = await pool.fetch(
        """
        SELECT floor(extract(epoch FROM at) / $5) * $5 AS bucket, avg(value) AS value
        FROM metric_sample
        WHERE host = $1 AND metric = $2 AND at >= $3 AND at <= $4
        GROUP BY bucket ORDER BY bucket
        """,
        host,
        metric,
        since,
        until,
        step,
    )
    return [[float(row["bucket"]), float(row["value"])] for row in rows]


async def series_for_metric(
    pool: Any,
    metric: str,
    hosts: list[str] | None,
    since: datetime,
    until: datetime,
    points: int = 300,
) -> list[dict[str, Any]]:
    """Every series for a metric (or family) across hosts, for one chart."""
    seconds = max(1, int((until - since).total_seconds()))
    step = max(1, seconds // max(1, points))
    family = metric.endswith(":")
    rows = await pool.fetch(
        """
        SELECT host, metric, floor(extract(epoch FROM at) / $6) * $6 AS bucket, avg(value) AS value
        FROM metric_sample
        WHERE (($5 AND metric LIKE $1 || '%') OR (NOT $5 AND metric = $1))
          AND ($2::text[] IS NULL OR host = ANY($2))
          AND at >= $3 AND at <= $4
        GROUP BY host, metric, bucket ORDER BY host, metric, bucket
        """,
        metric,
        hosts,
        since,
        until,
        family,
        step,
    )
    out: dict[tuple[str, str], list[list[float]]] = {}
    for row in rows:
        out.setdefault((row["host"], row["metric"]), []).append(
            [float(row["bucket"]), float(row["value"])]
        )
    return [
        {"host": host, "metric": name, "points": points_}
        for (host, name), points_ in sorted(out.items())
    ][:40]


async def latest(pool: Any, hosts: list[str] | None = None) -> list[dict[str, Any]]:
    """The newest value of every series per host, and when it arrived."""
    rows = await pool.fetch(
        """
        SELECT DISTINCT ON (host, metric) host, metric, value, at
        FROM metric_sample
        WHERE at > now() - interval '1 day' AND ($1::text[] IS NULL OR host = ANY($1))
        ORDER BY host, metric, at DESC
        """,
        hosts,
    )
    return [
        {"host": row["host"], "metric": row["metric"], "value": row["value"], "at": row["at"]}
        for row in rows
    ]


async def host_summary(pool: Any, hosts: list[str] | None = None) -> list[dict[str, Any]]:
    """One row per host: up or not, and the headline numbers."""
    values = await latest(pool, hosts)
    by_host: dict[str, dict[str, Any]] = {}
    now = datetime.now(UTC)
    for entry in values:
        summary = by_host.setdefault(
            entry["host"],
            {"host": entry["host"], "last_seen": entry["at"], "metrics": {}, "disks": {}},
        )
        summary["last_seen"] = max(summary["last_seen"], entry["at"])
        if entry["metric"].startswith("disk_percent:"):
            summary["disks"][entry["metric"].split(":", 1)[1]] = entry["value"]
        else:
            summary["metrics"][entry["metric"]] = entry["value"]
    interval = DEFAULT_INTERVAL
    for summary in by_host.values():
        age = (now - summary["last_seen"]).total_seconds()
        summary["age_seconds"] = int(age)
        summary["up"] = age < interval * 5
        # A probe target is not a machine: nothing reports from it, it is
        # only asked about. The machine table leaves these out; the probes
        # tab is where they are read.
        summary["probe_only"] = not summary["disks"] and all(
            metric.startswith("probe_") for metric in summary["metrics"]
        )
        if summary["probe_only"]:
            newest_probe = max(
                (entry["at"] for entry in values if entry["host"] == summary["host"]),
                default=summary["last_seen"],
            )
            summary["up"] = (now - newest_probe).total_seconds() < 3600
    return sorted(by_host.values(), key=lambda row: row["host"])


# ------------------------------------------------------------- evaluation --


def _holds(op: str, value: float, threshold: float) -> bool:
    return value > threshold if op == "gt" else value < threshold


async def _in_maintenance(pool: Any, host: str, now: datetime) -> bool:
    rows = await pool.fetch(
        """
        SELECT scope_kind, scope FROM monitor_maintenance
        WHERE starts_at <= $1 AND ends_at >= $1
        """,
        now,
    )
    for row in rows:
        covered = await hosts_in_scope(pool, row["scope_kind"], row["scope"])
        if covered is None or host in covered:
            return True
    return False


async def evaluate(pool: Any, settings: Settings | None = None) -> int:
    """One pass over the rules. Returns how many alerts changed state."""
    settings = settings or get_settings()
    now = datetime.now(UTC)
    changed = 0
    rules = await pool.fetch("SELECT * FROM monitor_rule WHERE enabled")
    for rule in rules:
        hosts = await hosts_in_scope(pool, rule["scope_kind"], rule["scope"])
        if rule["metric"] == "agent_up":
            firing = await _not_reporting(pool, hosts, rule["for_seconds"], now)
        else:
            firing = await _over_threshold(pool, rule, hosts, now)
        changed += await _reconcile(pool, settings, rule, firing, now)
    return changed


async def _not_reporting(
    pool: Any, hosts: list[str] | None, for_seconds: int, now: datetime
) -> dict[tuple[str, str], float]:
    """Hosts whose newest sample is older than the window. Hosts that never
    reported are not "not reporting"; only ones that stopped are."""
    rows = await pool.fetch(
        """
        SELECT host, max(at) AS last FROM metric_sample
        WHERE metric NOT LIKE 'probe_%'
          AND ($1::text[] IS NULL OR host = ANY($1))
          AND at > now() - ($2 || ' days')::interval
        GROUP BY host
        """,
        hosts,
        str(RETENTION_DAYS),
    )
    return {
        (row["host"], "agent_up"): 0.0
        for row in rows
        if (now - row["last"]).total_seconds() > for_seconds
    }


async def _over_threshold(
    pool: Any, rule: Any, hosts: list[str] | None, now: datetime
) -> dict[tuple[str, str], float]:
    """Series whose every sample in the window breaks the rule — and whose
    window is actually covered, so one bad sample at the start of a gap is
    not read as a condition that held for an hour."""
    window = max(int(rule["for_seconds"]), 0)
    # Read back at least two intervals, whatever the window: a rule that
    # fires "at once" still has to see the newest sample, which arrived up
    # to a minute ago.
    lookback = max(window, DEFAULT_INTERVAL * 2)
    family = rule["metric"].endswith(":")
    rows = await pool.fetch(
        """
        SELECT host, metric,
               min(value) AS low, max(value) AS high, min(at) AS first, max(at) AS last,
               (array_agg(value ORDER BY at DESC))[1] AS newest
        FROM metric_sample
        WHERE (($5 AND metric LIKE $1 || '%') OR (NOT $5 AND metric = $1))
          AND ($2::text[] IS NULL OR host = ANY($2))
          AND at >= $3::timestamptz - ($4 || ' seconds')::interval
        GROUP BY host, metric
        """,
        rule["metric"],
        hosts,
        now,
        str(lookback),
        family,
    )
    return judge(rule, rows, window)


def judge(rule: Any, rows: list[Any], window: int) -> dict[tuple[str, str], float]:
    """Which series the rule fires for, given each series' summary over the
    lookback. Pure, so the decision can be tested without a database."""
    firing: dict[tuple[str, str], float] = {}
    for row in rows:
        if window <= DEFAULT_INTERVAL:
            # "At once", or within one interval: the newest sample decides.
            if _holds(rule["op"], float(row["newest"]), rule["threshold"]):
                firing[(row["host"], row["metric"])] = float(row["newest"])
            continue
        edge = row["low"] if rule["op"] == "gt" else row["high"]
        if not _holds(rule["op"], edge, rule["threshold"]):
            continue
        covered = (row["last"] - row["first"]).total_seconds()
        if covered < window * 0.6:
            continue
        firing[(row["host"], row["metric"])] = float(row["newest"])
    return firing


async def _reconcile(
    pool: Any, settings: Settings, rule: Any, firing: dict[tuple[str, str], float], now: datetime
) -> int:
    """Open what is newly firing, resolve what no longer is, and tell."""
    changed = 0
    open_rows = await pool.fetch(
        "SELECT id, host, metric FROM monitor_alert WHERE rule_id = $1 AND state = 'firing'",
        rule["id"],
    )
    open_keys = {(row["host"], row["metric"]): row["id"] for row in open_rows}

    for key, value in firing.items():
        if key in open_keys:
            await pool.execute(
                "UPDATE monitor_alert SET last_value = $2 WHERE id = $1", open_keys[key], value
            )
            continue
        host, metric = key
        suppressed = await _in_maintenance(pool, host, now)
        message = describe(rule, host, metric, value)
        row = await pool.fetchrow(
            """
            INSERT INTO monitor_alert
                (rule_id, rule_name, host, metric, severity, last_value, message, suppressed)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
            """,
            rule["id"],
            rule["name"],
            host,
            metric,
            rule["severity"],
            value,
            message,
            suppressed,
        )
        changed += 1
        if not suppressed:
            await notify(
                pool, settings, rule, f"{rule['severity'].upper()}: {rule['name']}", message
            )
            await pool.execute(
                "UPDATE monitor_alert SET notified_at = now() WHERE id = $1", row["id"]
            )

    for key, alert_id in open_keys.items():
        if key in firing:
            continue
        await pool.execute(
            "UPDATE monitor_alert SET state = 'resolved', resolved_at = now() WHERE id = $1",
            alert_id,
        )
        changed += 1
        host, metric = key
        if not await _in_maintenance(pool, host, now):
            await notify(
                pool,
                settings,
                rule,
                f"Resolved: {rule['name']}",
                f"{host}: {metric_label(metric)} is back within limits.",
                resolved=True,
            )
    return changed


def metric_label(metric: str) -> str:
    base, _, suffix = metric.partition(":")
    for known in KNOWN_METRICS:
        if known["metric"].rstrip(":") == base:
            label = known["label"].replace(" (per mount)", "")
            return f"{label} {suffix}".strip() if suffix else label
    return metric


def describe(rule: Any, host: str, metric: str, value: float) -> str:
    if metric == "agent_up":
        return f"{host} has not reported for {rule['for_seconds'] // 60} minutes."
    if metric.startswith("probe_up"):
        return f"{host} is not answering its {metric.split(':', 1)[-1]} probe."
    verb = "over" if rule["op"] == "gt" else "under"
    held = (
        f"for {rule['for_seconds'] // 60} minutes" if rule["for_seconds"] >= 60 else "right now"
    )
    return f"{host}: {metric_label(metric)} is {value:.1f}, {verb} {rule['threshold']:g} {held}."


# ------------------------------------------------------------ notification --


async def notify(
    pool: Any, settings: Settings, rule: Any, title: str, message: str, *, resolved: bool = False
) -> None:
    """Tell every channel the rule names that takes this severity."""
    if not rule["channels"]:
        return
    channels = await pool.fetch(
        "SELECT * FROM monitor_channel WHERE id = ANY($1::uuid[])", list(rule["channels"])
    )
    for channel in channels:
        if rule["severity"] == "warning" and channel["min_severity"] == "critical":
            continue
        try:
            if channel["kind"] == "ntfy":
                await run_in_threadpool(
                    push.publish,
                    settings,
                    channel["topic"],
                    title,
                    message,
                    priority="default"
                    if resolved
                    else ("urgent" if rule["severity"] == "critical" else "high"),
                )
            elif channel["kind"] == "webhook":
                await run_in_threadpool(
                    _webhook,
                    channel["url"],
                    {
                        "title": title,
                        "message": message,
                        "rule": rule["name"],
                        "severity": rule["severity"],
                        "resolved": resolved,
                    },
                )
        except Exception as exc:  # noqa: BLE001 - one channel failing must not stop the rest
            log.warning("channel %s: %s", channel["name"], exc)


def _webhook(url: str, body: dict[str, Any]) -> None:
    with httpx.Client(timeout=10) as client:
        client.post(
            url, content=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
        )


async def send_test(pool: Any, settings: Settings, channel: Any) -> None:
    fake_rule = {"channels": [channel["id"]], "severity": "warning", "name": "Test"}
    await notify(pool, settings, fake_rule, "ODM monitoring: test", "This channel receives alerts.")


# ---------------------------------------------------------------- dashboards --


WIDGET_TYPES = ("chart", "stat", "hosts", "alerts", "text")


def validate_layout(layout: Any) -> dict[str, Any]:
    """A layout the console can draw, or a MonitorError saying what is wrong."""
    if not isinstance(layout, dict) or not isinstance(layout.get("widgets"), list):
        raise MonitorError("a layout is an object with a widgets list")
    widgets = []
    for index, widget in enumerate(layout["widgets"][:40]):
        if not isinstance(widget, dict):
            raise MonitorError(f"widget {index + 1} is not an object")
        kind = widget.get("type")
        if kind not in WIDGET_TYPES:
            raise MonitorError(f"widget {index + 1}: unknown type {kind!r}")
        clean: dict[str, Any] = {
            "id": str(widget.get("id") or f"w{index + 1}")[:32],
            "type": kind,
            "title": str(widget.get("title") or "")[:80],
            "w": int(widget.get("w") or 6),
            "h": int(widget.get("h") or 2),
        }
        if clean["w"] not in (3, 4, 6, 8, 12) or clean["h"] not in (1, 2, 3):
            raise MonitorError(f"widget {index + 1}: size must be a listed width and height")
        if kind in ("chart", "stat"):
            metric = str(widget.get("metric") or "")
            if not METRIC_RE.match(metric):
                raise MonitorError(f"widget {index + 1}: not a metric name")
            scope_kind = widget.get("scope_kind") or "all"
            if scope_kind not in ("all", "group", "host"):
                raise MonitorError(f"widget {index + 1}: unknown scope")
            clean.update(
                metric=metric,
                scope_kind=scope_kind,
                scope=str(widget.get("scope") or "")[:253],
                hours=max(1, min(int(widget.get("hours") or 6), 24 * RETENTION_DAYS)),
            )
        if kind == "text":
            clean["text"] = str(widget.get("text") or "")[:2000]
        widgets.append(clean)
    return {"widgets": widgets}


async def render(pool: Any, layout: dict[str, Any]) -> dict[str, Any]:
    """The data for every widget of a layout, in one answer."""
    now = datetime.now(UTC)
    data: dict[str, Any] = {}
    for widget in layout.get("widgets", []):
        kind = widget["type"]
        if kind == "chart":
            hosts = await hosts_in_scope(pool, widget["scope_kind"], widget["scope"])
            data[widget["id"]] = await series_for_metric(
                pool, widget["metric"], hosts, now - timedelta(hours=widget["hours"]), now
            )
        elif kind == "stat":
            hosts = await hosts_in_scope(pool, widget["scope_kind"], widget["scope"])
            values = [
                entry
                for entry in await latest(pool, hosts)
                if entry["metric"] == widget["metric"]
                or (widget["metric"].endswith(":") and entry["metric"].startswith(widget["metric"]))
            ]
            data[widget["id"]] = values
        elif kind == "hosts":
            data[widget["id"]] = await host_summary(pool)
        elif kind == "alerts":
            rows = await pool.fetch(
                """
                SELECT id, rule_name, host, metric, severity, message, started_at, suppressed
                FROM monitor_alert WHERE state = 'firing'
                ORDER BY (severity = 'critical') DESC, started_at DESC LIMIT 50
                """
            )
            data[widget["id"]] = [dict(row) | {"id": str(row["id"])} for row in rows]
    return data


# ------------------------------------------------------------------- loops --


async def evaluate_loop(pool: Any, settings: Settings) -> None:
    """Rules every half minute, retention once an hour. Runs with the app."""
    swept = datetime.now(UTC) - timedelta(hours=2)
    with contextlib.suppress(asyncio.CancelledError):
        while True:
            await asyncio.sleep(EVALUATE_SECONDS)
            try:
                active = await pool.fetchval(
                    "SELECT count(*) FROM server_role"
                    " WHERE role_name = 'monitoring' AND state <> 'removed'"
                )
                if not active:
                    continue
                await evaluate(pool, settings)
                if datetime.now(UTC) - swept > timedelta(hours=1):
                    await pool.execute(
                        "DELETE FROM metric_sample WHERE at < now() - ($1 || ' days')::interval",
                        str(RETENTION_DAYS),
                    )
                    await pool.execute(
                        "DELETE FROM monitor_alert WHERE state = 'resolved'"
                        " AND resolved_at < now() - interval '90 days'"
                    )
                    swept = datetime.now(UTC)
            except Exception as exc:  # noqa: BLE001 - the loop must outlive one bad pass
                log.warning("monitoring pass failed: %s", exc)


async def active(pool: Any) -> bool:
    return bool(
        await pool.fetchval(
            "SELECT count(*) FROM server_role WHERE role_name = 'monitoring' AND state <> 'removed'"
        )
    )


async def probing_nodes(pool: Any) -> set[str]:
    rows = await pool.fetch(
        "SELECT node_fqdn FROM server_role WHERE role_name = 'monitoring' AND state = 'active'"
    )
    return {row["node_fqdn"].lower() for row in rows}
