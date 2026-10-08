"""The control plane as several replicas in containers (docs/CONTAINERS.md).

The scheduled work runs once across replicas, a terminal or shared screen
held by one replica is reachable through any other, and in containers the
control plane installs its own replacement certificate.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import socket
import ssl
from pathlib import Path

import pytest
import uvicorn
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from odm import leader, replicas, roles
from odm.config import get_settings

# ------------------------------------------------------------------ leader ---


class LockConn:
    def __init__(self, world: dict, name: str) -> None:
        self.world, self.name, self.alive = world, name, True

    async def fetchval(self, query: str, *args):
        if not self.alive:
            raise ConnectionError("gone")
        if "pg_try_advisory_lock" in query:
            if self.world.get("holder") in (None, self.name):
                self.world["holder"] = self.name
                return True
            return False
        return 1

    async def execute(self, query: str, *args):
        if "pg_advisory_unlock" in query and self.world.get("holder") == self.name:
            self.world["holder"] = None


class LockPool:
    def __init__(self, world: dict, name: str) -> None:
        self.world, self.name, self.conn = world, name, None

    async def acquire(self):
        self.conn = LockConn(self.world, self.name)
        return self.conn

    async def release(self, conn) -> None:
        # What asyncpg's reset does: a released connection holds no locks.
        if self.world.get("holder") == self.name and conn.alive:
            self.world["holder"] = None


async def test_scheduled_work_runs_on_one_replica_and_moves_when_it_goes():
    world: dict = {}
    started: list[str] = []

    def starter(name: str):
        def start() -> list[asyncio.Task]:
            started.append(name)
            return [asyncio.create_task(asyncio.sleep(3600))]

        return start

    pool_a, pool_b = LockPool(world, "a"), LockPool(world, "b")
    a = asyncio.create_task(
        leader.run_while_leader(pool_a, starter("a"), retry_seconds=0.01, check_seconds=0.01)
    )
    await asyncio.sleep(0.05)
    b = asyncio.create_task(
        leader.run_while_leader(pool_b, starter("b"), retry_seconds=0.01, check_seconds=0.01)
    )
    await asyncio.sleep(0.1)
    assert started == ["a"]

    # Replica a loses its database connection: PostgreSQL drops the lock.
    pool_a.conn.alive = False
    world["holder"] = None
    a.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await a
    await asyncio.sleep(0.1)
    assert started == ["a", "b"]
    b.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await b


# ---------------------------------------------------------------- replicas ---


def test_one_replica_keeps_plain_session_ids():
    replicas._self_id = None
    assert "." not in replicas.new_session_id()
    assert replicas.owner_of("/api/v1/agent/shell/1.abcdefghijk", websocket=True) is None


def test_session_ids_name_their_replica_and_others_are_forwarded():
    replicas._self_id = 3
    try:
        mine = replicas.new_session_id()
        assert mine.startswith("3.")
        assert replicas.owner_of(f"/api/v1/agent/shell/{mine}", websocket=True) is None
        other = "5." + mine.split(".", 1)[1]
        for path in (
            f"/api/v1/agent/shell/{other}",
            f"/api/v1/agent/assist/{other}",
            f"/api/v1/servers/computer/shell/session/{other}",
            f"/api/v1/servers/computer/assist/session/{other}",
        ):
            assert replicas.owner_of(path, websocket=True) == 5
        assert (
            replicas.owner_of(f"/api/v1/servers/computer/assist/session/{other}", websocket=False)
            == 5
        )
        # Nothing else is ever carried anywhere.
        assert replicas.owner_of(f"/api/v1/servers/computer/shell/{other}", websocket=False) is None
        assert replicas.owner_of("/api/v1/agent/shell/5.x/../../etc", websocket=True) is None
    finally:
        replicas._self_id = None


def _certificate(tmp: Path, name: str) -> Path:
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    now = dt.datetime.now(dt.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    tmp.mkdir(parents=True, exist_ok=True)
    (tmp / "api.crt").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (tmp / "api.key").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return tmp


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


async def _serve(app, port: int, tls: Path) -> uvicorn.Server:
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            ssl_certfile=str(tls / "api.crt"),
            ssl_keyfile=str(tls / "api.key"),
            log_level="warning",
            lifespan="off",
        )
    )
    asyncio.create_task(server.serve())
    for _ in range(200):
        if server.started:
            return server
        await asyncio.sleep(0.02)
    raise RuntimeError("server did not start")


async def test_a_socket_for_another_replicas_session_reaches_it(tmp_path, monkeypatch):
    from websockets.asyncio.client import connect

    tls = _certificate(tmp_path / "tls", "odm.corp.example.internal")
    settings = get_settings().model_copy(
        update={"tls_dir": tls, "console_url": "https://odm.corp.example.internal:8443"}
    )
    monkeypatch.setattr(replicas, "get_settings", lambda: settings)

    seen: dict = {}

    async def owner(scope, receive, send):
        # The replica holding the session: echoes, and says what it was handed.
        assert scope["type"] == "websocket"
        headers = dict(scope["headers"])
        seen["path"] = scope["path"]
        seen["authorization"] = headers.get(b"authorization")
        seen["origin"] = headers.get(b"origin")
        await receive()
        await send({"type": "websocket.accept"})
        while True:
            message = await receive()
            if message["type"] == "websocket.disconnect":
                return
            if message.get("bytes") is not None:
                await send({"type": "websocket.send", "bytes": b"echo:" + message["bytes"]})
            else:
                await send({"type": "websocket.send", "text": "echo:" + message["text"]})

    async def local(scope, receive, send):
        raise AssertionError("a session held elsewhere must not be handled here")

    owner_port, front_port = _free_port(), _free_port()
    owner_server = await _serve(owner, owner_port, tls)
    front_server = await _serve(replicas.ReplicaForwarder(local), front_port, tls)
    replicas._self_id = 1
    replicas._known[2] = f"https://127.0.0.1:{owner_port}"
    try:
        client_tls = ssl.create_default_context(cafile=str(tls / "api.crt"))
        async with connect(
            f"wss://127.0.0.1:{front_port}/api/v1/agent/shell/2.abcdefghijklmnop",
            ssl=client_tls,
            server_hostname="odm.corp.example.internal",
            additional_headers={"Authorization": "Negotiate dGlja2V0"},
            origin="https://odm.corp.example.internal",  # type: ignore[arg-type]
        ) as ws:
            await ws.send(b"\x00ls\n")
            assert await ws.recv() == b"echo:\x00ls\n"
            await ws.send("token")
            assert await ws.recv() == "echo:token"
        assert seen["path"] == "/api/v1/agent/shell/2.abcdefghijklmnop"
        assert seen["authorization"] == b"Negotiate dGlja2V0"
        assert seen["origin"] == b"https://odm.corp.example.internal"
    finally:
        replicas._self_id = None
        replicas._known.clear()
        owner_server.should_exit = True
        front_server.should_exit = True
        await asyncio.sleep(0.2)


async def test_a_replica_that_cannot_be_reached_refuses_like_a_missing_session(
    tmp_path, monkeypatch
):
    tls = _certificate(tmp_path / "tls", "odm.corp.example.internal")
    settings = get_settings().model_copy(update={"tls_dir": tls})
    monkeypatch.setattr(replicas, "get_settings", lambda: settings)
    replicas._self_id = 1
    replicas._known[2] = f"https://127.0.0.1:{_free_port()}"
    sent: list = []

    async def receive():
        return {"type": "websocket.connect"}

    async def send(message):
        sent.append(message)

    try:
        forwarder = replicas.ReplicaForwarder(None)
        await forwarder(
            {"type": "websocket", "path": "/api/v1/agent/assist/2.abcdefghijklmnop", "headers": []},
            receive,
            send,
        )
    finally:
        replicas._self_id = None
        replicas._known.clear()
    assert sent == [{"type": "websocket.close", "code": 4404}]


# --------------------------------------------------- console certificate ---


def _pair(tmp: Path, name: str) -> tuple[str, str]:
    _certificate(tmp, name)
    return (tmp / "api.crt").read_text(), (tmp / "api.key").read_text()


def test_container_installs_its_own_console_certificate(tmp_path, monkeypatch):
    staging = tmp_path / "staging"
    monkeypatch.setattr(roles, "STAGING_DIR", str(staging))
    tls = tmp_path / "tls"
    old_cert, old_key = _pair(tmp_path / "old", "odm.corp.example.internal")
    tls.mkdir()
    (tls / "api.crt").write_text(old_cert)
    (tls / "api.key").write_text(old_key)
    settings = get_settings().model_copy(update={"tls_dir": tls})

    new_cert, new_key = _pair(tmp_path / "new", "odm.corp.example.internal")
    roles.stage_console_certificate(settings, new_cert, new_key)
    roles.install_staged_console_certificate(settings)

    assert (tls / "api.crt").read_text() == new_cert
    assert (tls / "api.key").read_text() == new_key
    assert (tls / "api.crt.previous").read_text() == old_cert
    assert (tls / "api.key").stat().st_mode & 0o077 == 0
    assert not (staging / "console.key").exists()


def test_a_mismatched_pair_is_refused_and_the_console_keeps_its_own(tmp_path, monkeypatch):
    staging = tmp_path / "staging"
    monkeypatch.setattr(roles, "STAGING_DIR", str(staging))
    tls = tmp_path / "tls"
    old_cert, old_key = _pair(tmp_path / "old", "odm.corp.example.internal")
    tls.mkdir()
    (tls / "api.crt").write_text(old_cert)
    (tls / "api.key").write_text(old_key)
    settings = get_settings().model_copy(update={"tls_dir": tls})

    cert_a, _ = _pair(tmp_path / "a", "odm.corp.example.internal")
    _, key_b = _pair(tmp_path / "b", "odm.corp.example.internal")
    roles.stage_console_certificate(settings, cert_a, key_b)
    with pytest.raises(roles.RoleError, match="do not match"):
        roles.install_staged_console_certificate(settings)
    assert (tls / "api.crt").read_text() == old_cert


def test_controller_node_defaults_to_this_host():
    assert get_settings().controller_node == socket.getfqdn()


async def test_the_viewers_request_for_another_replicas_offer_reaches_it(tmp_path, monkeypatch):
    import httpx

    tls = _certificate(tmp_path / "tls", "odm.corp.example.internal")
    settings = get_settings().model_copy(
        update={"tls_dir": tls, "console_url": "https://odm.corp.example.internal:8443"}
    )
    monkeypatch.setattr(replicas, "get_settings", lambda: settings)

    async def owner(scope, receive, send):
        cookie = dict(scope["headers"]).get(b"cookie", b"")
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"x-content-type-options", b"nosniff"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": b'{"cookie":"' + cookie + b'"}'})

    async def local(scope, receive, send):
        raise AssertionError("an offer held elsewhere must not be answered here")

    owner_port, front_port = _free_port(), _free_port()
    owner_server = await _serve(owner, owner_port, tls)
    front_server = await _serve(replicas.ReplicaForwarder(local), front_port, tls)
    replicas._self_id = 1
    replicas._known[2] = f"https://127.0.0.1:{owner_port}"
    try:
        async with httpx.AsyncClient(verify=replicas.tls_context(settings)) as client:
            response = await client.get(
                f"https://127.0.0.1:{front_port}/api/v1/servers/computer/assist/session/"
                "2.abcdefghijklmnop",
                headers={"Cookie": "odm_session=abc"},
                extensions={"sni_hostname": "odm.corp.example.internal"},
            )
        assert response.status_code == 200
        assert response.json() == {"cookie": "odm_session=abc"}
        # The owner's security headers come back with its answer.
        assert response.headers["x-content-type-options"] == "nosniff"
    finally:
        replicas._self_id = None
        replicas._known.clear()
        owner_server.should_exit = True
        front_server.should_exit = True
        await asyncio.sleep(0.2)


def test_the_notification_server_is_checked_against_the_consoles_name():
    import httpx

    from odm import push

    settings = get_settings().model_copy(
        update={
            "ntfy_url": "https://odm-ntfy:8444",
            "ntfy_token": "tk_x",
            "ntfy_tls_server_name": "odm.corp.example.internal",
        }
    )
    with push._client(settings) as client:
        request = client.build_request("POST", "https://odm-ntfy:8444/topic")
        for hook in client.event_hooks["request"]:
            hook(request)
    assert request.extensions["sni_hostname"] == "odm.corp.example.internal"
    assert isinstance(request, httpx.Request)
