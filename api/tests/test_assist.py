"""A shared screen: the agent's connection and the viewer's meet here."""

from __future__ import annotations

import json

import conftest  # noqa: F401  (environment setup ordering)
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from odm import assist, directory
from odm.main import create_app
from odm.routes_agent import Machine, require_machine_socket

MACHINE_DN = "CN=WS01,CN=Computers,DC=corp,DC=example,DC=internal"


@pytest.fixture
def console(state, monkeypatch) -> TestClient:
    app = create_app()
    app.state.pool = conftest.FakePool(state)
    app.dependency_overrides[require_machine_socket] = lambda: Machine(
        dn=MACHINE_DN, hostname="ws01.corp.example.internal", sam_account_name="WS01$"
    )
    monkeypatch.setattr(
        directory, "authenticate", lambda settings, username, password: conftest.ADMIN
    )
    client = TestClient(app, base_url="https://odm.corp.example.internal")
    response = client.post("/api/v1/auth/login", json={"username": "ada", "password": "pw"})
    assert response.status_code == 200, response.text
    client.headers["X-ODM-CSRF"] = response.json()["csrf_token"]
    client.headers["Origin"] = "https://odm.corp.example.internal"
    return client


def connect(console: TestClient, path: str):
    return console.websocket_connect(path, cookies=dict(console.cookies))


def offered_for(state: dict) -> assist.Offer:
    offer = assist.registry.create(
        dn=MACHINE_DN,
        hostname="ws01.corp.example.internal",
        username="alice",
        admin_session_id=str(state["session"]["id"]),
        principal="ada@CORP.EXAMPLE.INTERNAL",
        principal_sid="S-1-5-21-1-2-3-1104",
        source_ip="10.0.0.7",
        minutes=30,
    )
    offer.protocol = "vnc"
    offer.password = "s3cret"
    return offer


def test_the_viewer_page_reads_the_offer_back_and_nobody_else_does(console, state):
    offer = offered_for(state)
    response = console.get(f"/api/v1/servers/computer/assist/session/{offer.id}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["username"] == "alice" and body["password"] == "s3cret"
    assert 0 < body["seconds_left"] <= 1800

    offer.admin_session_id = "somebody-else"
    assert console.get(f"/api/v1/servers/computer/assist/session/{offer.id}").status_code == 404
    assert console.get("/api/v1/servers/computer/assist/session/nonsense").status_code == 404


def test_the_agent_waits_and_is_told_to_open_when_a_viewer_attaches(console, state):
    offer = offered_for(state)
    csrf = console.headers["X-ODM-CSRF"]
    with connect(console, f"/api/v1/agent/assist/{offer.id}") as agent:
        with connect(console, f"/api/v1/servers/computer/assist/session/{offer.id}") as page:
            page.send_text(json.dumps({"csrf": csrf}))
            assert page.receive_text() == "ready"
            # The agent is told a viewer is there, and only then connects to
            # the VNC server; the greeting flows to the page, the answer back.
            assert agent.receive_text() == "open"
            agent.send_bytes(b"RFB 003.008\n")
            assert page.receive_bytes() == b"RFB 003.008\n"
            page.send_bytes(b"RFB 003.008\n")
            assert agent.receive_bytes() == b"RFB 003.008\n"
        # The page closed: the agent's connection is closed too, so it
        # comes back for the next viewer.
        with pytest.raises(WebSocketDisconnect):
            agent.receive_bytes()

    rows = conftest.audit_rows(state)
    views = [row for row in rows if row["action"] == "computer.assist.view"]
    assert len(views) == 1, rows
    assert views[0]["object_dn"] == MACHINE_DN
    assert json.loads(views[0]["after"])["user"] == "alice"
    inserts = [
        args for sql, args in state["executed"]
        if "INSERT INTO computer_event" in sql and "console-assist" in sql
    ]
    assert inserts and inserts[0][0] == MACHINE_DN


def test_a_machine_cannot_attach_to_an_offer_meant_for_another(console, state):
    offer = offered_for(state)
    offer.dn = "CN=OTHER,CN=Computers,DC=corp,DC=example,DC=internal"
    with pytest.raises(WebSocketDisconnect) as refused:
        with connect(console, f"/api/v1/agent/assist/{offer.id}"):
            pass
    assert refused.value.code == 4404


def test_only_the_console_session_that_asked_may_watch(console, state):
    offer = offered_for(state)
    offer.admin_session_id = "somebody-else"
    with pytest.raises(WebSocketDisconnect) as refused:
        with connect(console, f"/api/v1/servers/computer/assist/session/{offer.id}"):
            pass
    assert refused.value.code == 4401


def test_a_viewer_without_the_machine_is_told_so(console, state, monkeypatch):
    offer = offered_for(state)
    monkeypatch.setattr(assist, "AGENT_WAIT_SECONDS", 0.2)
    csrf = console.headers["X-ODM-CSRF"]
    with pytest.raises(WebSocketDisconnect) as closed:
        with connect(console, f"/api/v1/servers/computer/assist/session/{offer.id}") as page:
            page.send_text(json.dumps({"csrf": csrf}))
            page.receive_text()
    assert closed.value.code == 4408
    assert "did not connect" in closed.value.reason


def test_an_expired_offer_is_gone():
    offer = assist.registry.create(
        dn=MACHINE_DN, hostname="ws01", username="alice", admin_session_id="s",
        principal="ada", principal_sid="S-1", source_ip=None, minutes=1,
    )
    assert assist.registry.get(offer.id) is offer
    offer.created_at -= 61
    assert assist.registry.get(offer.id) is None
