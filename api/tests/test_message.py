"""A message to the people at some machines: one task and one audit row each."""

from __future__ import annotations

import conftest  # noqa: F401  (environment setup ordering)
import pytest
from starlette.testclient import TestClient

from odm import directory, tasks
from odm.main import create_app

KNOWN = "CN=WS01,CN=Computers,DC=corp,DC=example,DC=internal"
UNKNOWN = "CN=NEVER,CN=Computers,DC=corp,DC=example,DC=internal"


@pytest.fixture
def console(state, monkeypatch) -> TestClient:
    app = create_app()
    app.state.pool = conftest.FakePool(state)
    monkeypatch.setattr(
        directory, "authenticate", lambda settings, username, password: conftest.ADMIN
    )
    original = conftest.FakeConn.fetchrow

    async def fetchrow(self, sql, *args):
        if "FROM computer_fact" in sql and args and args[0] == KNOWN:
            return {"hostname": "ws01.corp.example.internal", "computer_dn": KNOWN}
        if "FROM computer_fact" in sql:
            return None
        return await original(self, sql, *args)

    monkeypatch.setattr(conftest.FakeConn, "fetchrow", fetchrow)
    queued: list[dict] = []

    async def enqueue(conn, **kwargs):
        queued.append(kwargs)
        return "task-id"

    monkeypatch.setattr(tasks, "enqueue", enqueue)
    state["queued"] = queued
    client = TestClient(app, base_url="https://odm.corp.example.internal")
    response = client.post("/api/v1/auth/login", json={"username": "ada", "password": "pw"})
    assert response.status_code == 200, response.text
    client.headers["X-ODM-CSRF"] = response.json()["csrf_token"]
    client.headers["Origin"] = "https://odm.corp.example.internal"
    return client


def test_a_message_is_queued_per_machine_and_audited(console, state):
    response = console.post(
        "/api/v1/servers/computer/message",
        json={
            "dns": [KNOWN, UNKNOWN],
            "title": "Maintenance",
            "text": "Back at 18:00.",
            "urgency": "critical",
        },
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["queued"] == ["ws01.corp.example.internal"]
    assert body["missing"] == [UNKNOWN]
    [task] = state["queued"]
    assert task["kind"] == "message" and task["subject"] == KNOWN
    assert task["payload"]["text"] == "Back at 18:00." and task["payload"]["urgency"] == "critical"
    rows = [row for row in conftest.audit_rows(state) if row["action"] == "computer.message"]
    assert len(rows) == 1 and rows[0]["object_dn"] == KNOWN


def test_an_empty_message_is_refused(console):
    response = console.post(
        "/api/v1/servers/computer/message", json={"dns": [KNOWN], "text": ""}
    )
    assert response.status_code == 422
