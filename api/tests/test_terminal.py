"""A terminal on a machine: the two ends meet here, and the record is kept."""

from __future__ import annotations

import json

import conftest  # noqa: F401  (environment setup ordering)
import pytest
from starlette.testclient import TestClient

from odm import directory, terminal
from odm.main import create_app
from odm.routes_agent import Machine, require_machine_socket

MACHINE_DN = "CN=WS01,CN=Computers,DC=corp,DC=example,DC=internal"


def test_a_control_frame_round_trips_and_data_is_not_one():
    frame = terminal.control(type="resize", cols=120, rows=40)
    assert frame[0] == terminal.FRAME_CONTROL
    assert terminal.parse_control(frame) == {"type": "resize", "cols": 120, "rows": 40}
    assert terminal.parse_control(bytes([terminal.FRAME_DATA]) + b"ls\n") is None
    assert terminal.parse_control(b"") is None
    assert terminal.parse_control(bytes([terminal.FRAME_CONTROL]) + b"[1,2]") is None


def test_the_transcript_keeps_the_end_of_a_long_session():
    term = terminal.Terminal(
        id="t", dn=MACHINE_DN, hostname="ws01", admin_session_id="s", principal="ada",
        principal_sid="S-1", source_ip=None, cols=80, rows=24,
    )
    term.note_output(b"x" * (terminal.TRANSCRIPT_BYTES + 10))
    term.note_output(b"THE END")
    assert len(term.transcript) == terminal.TRANSCRIPT_BYTES
    assert term.transcript.endswith(b"THE END")


def test_closing_is_once_and_the_first_reason_stays():
    term = terminal.Terminal(
        id="t", dn=MACHINE_DN, hostname="ws01", admin_session_id="s", principal="ada",
        principal_sid="S-1", source_ip=None, cols=80, rows=24,
    )
    term.close("the shell exited")
    term.close("the console went away")
    assert term.reason == "the shell exited"
    assert term.record() is not None
    assert term.record() is None, "the record must be written once"


@pytest.fixture
def console(state, monkeypatch) -> TestClient:
    """A signed-in console that can open WebSockets, with the agent's
    Kerberos check standing in for a machine called WS01."""
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
    """websocket_connect, with the console's cookie: the test client rewrites
    the URL's host to "testserver", which the cookie jar does not match."""
    return console.websocket_connect(path, cookies=dict(console.cookies))


def opened_for(state: dict) -> terminal.Terminal:
    return terminal.registry.create(
        dn=MACHINE_DN,
        hostname="ws01.corp.example.internal",
        admin_session_id=str(state["session"]["id"]),
        principal="ada@CORP.EXAMPLE.INTERNAL",
        principal_sid="S-1-5-21-1-2-3-1104",
        source_ip="10.0.0.7",
        cols=80,
        rows=24,
    )


def test_what_the_machine_prints_reaches_the_console_and_back(console, state):
    term = opened_for(state)
    csrf = console.headers["X-ODM-CSRF"]
    with connect(console, f"/api/v1/servers/computer/shell/session/{term.id}") as page:
        page.send_text(json.dumps({"csrf": csrf}))
        waiting = terminal.parse_control(page.receive_bytes())
        assert waiting["type"] == "status" and "Connecting" in waiting["text"]

        with connect(console, f"/api/v1/agent/shell/{term.id}") as agent:
            ready = terminal.parse_control(page.receive_bytes())
            assert ready == {"type": "status", "text": ""}

            agent.send_bytes(bytes([terminal.FRAME_DATA]) + b"root@ws01:~# ")
            assert page.receive_bytes() == bytes([terminal.FRAME_DATA]) + b"root@ws01:~# "

            page.send_bytes(bytes([terminal.FRAME_DATA]) + b"uptime\r")
            assert agent.receive_bytes() == bytes([terminal.FRAME_DATA]) + b"uptime\r"

            page.send_bytes(terminal.control(type="resize", cols=132, rows=43))
            assert terminal.parse_control(agent.receive_bytes())["cols"] == 132

            agent.send_bytes(terminal.control(type="exit", status=0))
            ended = terminal.parse_control(page.receive_bytes())
            assert ended["type"] == "exit"

    # The record: who, which machine, what was typed and what came back.
    rows = conftest.audit_rows(state)
    session_rows = [row for row in rows if row["action"] == "computer.shell.session"]
    assert len(session_rows) == 1, rows
    row = session_rows[0]
    assert row["object_dn"] == MACHINE_DN
    assert row["actor"] == "ada@CORP.EXAMPLE.INTERNAL"
    after = json.loads(row["after"])
    assert "uptime" in after["typed"]
    assert "root@ws01" in after["transcript"]
    assert after["exit_status"] == 0
    # And the machine's own activity list has the session in it.
    inserts = [
        args for sql, args in state["executed"]
        if "INSERT INTO computer_event" in sql and "console-shell" in sql
    ]
    assert inserts and inserts[0][0] == MACHINE_DN


def test_only_the_console_session_that_asked_may_attach(console, state):
    term = opened_for(state)
    term.admin_session_id = "somebody-else"
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as refused:
        with connect(console, f"/api/v1/servers/computer/shell/session/{term.id}"):
            pass
    assert refused.value.code == 4401


def test_a_page_from_another_origin_is_refused_before_anything_is_bridged(console, state):
    term = opened_for(state)
    from starlette.websockets import WebSocketDisconnect

    console.headers["Origin"] = "https://evil.example.org"
    with pytest.raises(WebSocketDisconnect) as refused:
        with connect(console, f"/api/v1/servers/computer/shell/session/{term.id}"):
            pass
    assert refused.value.code == 4404


def test_the_wrong_csrf_token_is_refused(console, state):
    term = opened_for(state)
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as refused:
        with connect(console, f"/api/v1/servers/computer/shell/session/{term.id}") as page:
            page.send_text(json.dumps({"csrf": "not-it"}))
            page.receive_bytes()
    assert refused.value.code == 4403


def test_a_machine_cannot_attach_to_another_machines_terminal(console, state):
    term = opened_for(state)
    term.dn = "CN=OTHER,CN=Computers,DC=corp,DC=example,DC=internal"
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as refused:
        with connect(console, f"/api/v1/agent/shell/{term.id}"):
            pass
    assert refused.value.code == 4404


def test_every_websocket_route_is_gated():
    """The surface tests walk HTTP routes; these are the other kind."""
    from fastapi.routing import APIWebSocketRoute

    sockets = []
    pending = list(create_app().routes)
    while pending:
        route = pending.pop()
        if isinstance(route, APIWebSocketRoute):
            sockets.append(route)
            continue
        included = getattr(route, "original_router", None)
        if included is not None:
            pending.extend(included.routes)
        elif hasattr(route, "routes"):
            pending.extend(route.routes)
    assert {route.path for route in sockets} == {
        "/api/v1/servers/computer/shell/session/{session_id}",
        "/api/v1/agent/shell/{session_id}",
        "/api/v1/servers/computer/assist/session/{session_id}",
        "/api/v1/agent/assist/{session_id}",
        # The vault's live-update socket, carried to the node; the vault
        # authenticates it itself.
        "/vault/notifications/hub",
        "/vault/notifications/anonymous-hub",
    }
    for route in sockets:
        names = {d.call.__name__ for d in route.dependant.dependencies if d.call}
        if route.path.startswith("/vault/"):
            continue
        if route.path.startswith("/api/v1/agent/"):
            assert "require_machine_socket" in names, route.path
        else:
            # The console's end checks the cookie and the CSRF token itself,
            # inside the handler, because a WebSocket cannot answer 401.
            source = route.endpoint.__code__.co_names
            assert "load" in source and "compare_digest" in source, route.path
