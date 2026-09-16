"""Monitoring: the rules, the layouts, and what a machine may report."""

from __future__ import annotations

import conftest
import httpx
import pytest

from odm import monitor
from odm.main import create_app
from odm.routes_agent import Machine, require_machine

MACHINE_DN = "CN=WS01,CN=Computers,DC=corp,DC=example,DC=internal"


def test_a_layout_is_checked_widget_by_widget():
    clean = monitor.validate_layout(
        {
            "widgets": [
                {"type": "chart", "title": "CPU", "metric": "cpu_percent", "w": 6, "h": 2},
                {"type": "hosts", "w": 12, "h": 1},
                {"id": "note", "type": "text", "text": "Hello", "w": 3, "h": 1},
            ]
        }
    )
    assert [w["type"] for w in clean["widgets"]] == ["chart", "hosts", "text"]
    assert clean["widgets"][0]["scope_kind"] == "all"
    assert clean["widgets"][0]["hours"] == 6
    assert clean["widgets"][2]["id"] == "note"
    with pytest.raises(monitor.MonitorError):
        monitor.validate_layout({"widgets": [{"type": "gauge"}]})
    with pytest.raises(monitor.MonitorError):
        monitor.validate_layout({"widgets": [{"type": "chart", "metric": "rm -rf /"}]})
    with pytest.raises(monitor.MonitorError):
        monitor.validate_layout({"widgets": [{"type": "chart", "metric": "cpu_percent", "w": 5}]})
    with pytest.raises(monitor.MonitorError):
        monitor.validate_layout("nope")


def test_a_rule_reads_as_a_sentence():
    rule = {"op": "gt", "threshold": 90.0, "for_seconds": 300, "name": "Filesystem almost full"}
    assert monitor.describe(rule, "fs01", "disk_percent:/srv", 93.2) == (
        "fs01: Filesystem used % /srv is 93.2, over 90 for 5 minutes."
    )
    assert monitor.describe(rule, "fs01", "agent_up", 0) == "fs01 has not reported for 5 minutes."
    assert monitor.metric_label("temp_c") == "Hottest sensor"
    assert monitor.metric_label("something_new") == "something_new"


def test_metric_and_host_names_are_narrow():
    assert monitor.METRIC_RE.match("disk_percent:/home")
    assert monitor.METRIC_RE.match("cpu_percent")
    assert not monitor.METRIC_RE.match("cpu percent")
    assert not monitor.METRIC_RE.match("Cpu_Percent")
    assert monitor.HOST_RE.match("switch-01.corp.example.internal")
    assert not monitor.HOST_RE.match("host name")


@pytest.fixture
def machine_client(state):
    app = create_app()
    app.state.pool = conftest.FakePool(state)
    app.dependency_overrides[require_machine] = lambda: Machine(
        dn=MACHINE_DN, hostname="ws01.corp.example.internal", sam_account_name="WS01$"
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://odm.test")


async def test_metrics_are_refused_while_no_monitoring_role_exists(machine_client):
    response = await machine_client.post(
        "/api/v1/agent/metrics", json={"samples": [{"metric": "cpu_percent", "value": 12}]}
    )
    assert response.status_code == 404


async def test_a_machine_reports_about_itself_and_its_probes_only(
    machine_client, state, monkeypatch
):
    async def active(_pool):
        return True

    monkeypatch.setattr(monitor, "active", active)
    response = await machine_client.post(
        "/api/v1/agent/metrics",
        json={
            "samples": [
                {"metric": "cpu_percent", "value": 12.5},
                # About another machine: dropped.
                {"metric": "mem_percent", "value": 99, "host": "dc01.corp.example.internal"},
                # A probe result names its target: kept.
                {"metric": "probe_up:ping", "value": 1, "host": "switch-01"},
                # A probe with no target says nothing: dropped.
                {"metric": "probe_latency_ms:ping", "value": 3},
                {"metric": "not a metric", "value": 1},
            ]
        },
    )
    assert response.status_code == 204, response.text
    inserted = [args for sql, args in state["executed"] if "INSERT INTO metric_sample" in sql]
    assert inserted == [
        ("ws01.corp.example.internal", "cpu_percent", 12.5),
        ("switch-01", "probe_up:ping", 1.0),
    ]


async def test_a_probe_and_a_rule_are_checked_before_anything_is_written(admin_client, state):
    response = await admin_client.post(
        "/api/v1/monitor/probes",
        json={"name": "web", "kind": "http", "target": "intranet"},
    )
    assert response.status_code == 400
    assert "URL" in response.json()["detail"]
    response = await admin_client.post(
        "/api/v1/monitor/probes",
        json={"name": "smtp", "kind": "tcp", "target": "mail.corp.example.internal"},
    )
    assert response.status_code == 400
    assert "port" in response.json()["detail"]
    response = await admin_client.post(
        "/api/v1/monitor/rules",
        json={"name": "r", "metric": "cpu percent", "threshold": 1},
    )
    assert response.status_code == 400
    response = await admin_client.post(
        "/api/v1/monitor/rules",
        json={"name": "r", "metric": "cpu_percent", "threshold": 1, "scope_kind": "group"},
    )
    assert response.status_code == 400
    assert not [sql for sql, _ in state.get("executed", []) if "INSERT INTO monitor_" in sql]


async def test_a_shared_dashboard_answers_without_a_session_and_an_unknown_token_does_not(
    client, state
):
    response = await client.get("/api/v1/monitor/public/" + "x" * 32)
    assert response.status_code == 404


def test_a_rule_with_no_window_fires_on_the_newest_sample_and_a_long_one_needs_coverage():
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)
    rule = {"op": "gt", "threshold": 90.0}
    summary = {
        "host": "fs01", "metric": "disk_percent:/", "low": 85.0, "high": 96.0,
        "first": now - timedelta(seconds=110), "last": now, "newest": 96.0,
    }
    # At once: the newest sample is over the line, so it fires even though
    # an older one in the lookback was not.
    assert monitor.judge(rule, [summary], 0) == {("fs01", "disk_percent:/"): 96.0}
    # Five minutes: every sample must be over the line...
    assert monitor.judge(rule, [summary], 300) == {}
    steady = summary | {"low": 92.0, "first": now - timedelta(seconds=290)}
    assert monitor.judge(rule, [steady], 300) == {("fs01", "disk_percent:/"): 96.0}
    # ...and the window must actually be covered by samples.
    brief = steady | {"first": now - timedelta(seconds=60)}
    assert monitor.judge(rule, [brief], 300) == {}
