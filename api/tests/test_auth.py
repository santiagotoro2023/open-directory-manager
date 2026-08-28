"""Phase 1 gate: only members of the admin group get a session."""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from odm import directory, sessions
from odm.config import derive_base_dn, get_settings
from odm.directory import InvalidCredentials, nested_member_filter, validate_username
from odm.main import create_app

ADMIN = directory.DirectoryUser(
    dn="CN=ada,OU=Example Corp,DC=corp,DC=example,DC=internal",
    sam_account_name="ada",
    user_principal_name="ada@CORP.EXAMPLE.INTERNAL",
    display_name="Ada Admin",
    sid="S-1-5-21-1-2-3-1104",
)


# --------------------------------------------------------------- pure bits ---


def test_derive_base_dn():
    assert derive_base_dn("corp.example.internal") == "DC=corp,DC=example,DC=internal"


@pytest.mark.parametrize("bad", ["", "   ", "ada)(uid=*", "ada*", "a" * 200, "ada@ex ample"])
def test_validate_username_rejects_injection(bad):
    with pytest.raises(InvalidCredentials):
        validate_username(bad)


def test_validate_username_accepts_real_names():
    assert validate_username("ada.lovelace") == "ada.lovelace"
    assert validate_username("ada@corp.example.internal") == "ada@corp.example.internal"


def test_nested_member_filter_escapes_and_walks_nesting():
    filt = nested_member_filter("CN=a*b,DC=x", "CN=Domain Admins,DC=x")
    assert "1.2.840.113556.1.4.1941" in filt
    assert "a*b" not in filt and r"a\2ab" in filt


def test_empty_password_never_reaches_the_dc():
    # An empty password is an LDAP unauthenticated bind, which succeeds.
    with pytest.raises(InvalidCredentials):
        directory.authenticate(get_settings(), "ada", "")


def test_should_lock():
    assert not sessions.should_lock(4, 5)
    assert sessions.should_lock(5, 5)


# ------------------------------------------------------------ fake backend ---


class FakeConn:
    def __init__(self, state: dict):
        self.state = state

    async def execute(self, sql, *args):
        self.state.setdefault("executed", []).append((sql, args))

    async def fetchval(self, sql, *args):
        if "count(*)" in sql:
            return self.state.get("failures", 0)
        if "revoked_at = now()" in sql:
            self.state["session"] = None
            return ADMIN.user_principal_name
        return None

    async def fetchrow(self, sql, *args):
        if "INSERT INTO admin_session" in sql:
            self.state["session"] = {
                "token_sha256": args[0],
                "id": uuid.uuid4(),
                "csrf_token": args[1],
                "principal": args[2],
                "principal_dn": args[3],
                "principal_sid": args[4],
                "display_name": args[5],
                "expires_at": datetime.now(UTC) + timedelta(hours=8),
            }
            return self.state["session"]
        if "last_seen_at = now()" in sql:
            live = self.state.get("session")
            return live if live and live["token_sha256"] == args[0] else None
        return None


class FakePool:
    def __init__(self, state: dict):
        self.state = state

    @asynccontextmanager
    async def acquire(self):
        yield FakeConn(self.state)


@pytest.fixture
def client(monkeypatch):
    state: dict = {}
    app = create_app()
    app.state.pool = FakePool(state)
    transport = httpx.ASGITransport(app=app)  # no lifespan: no real DB
    http = httpx.AsyncClient(transport=transport, base_url="https://odm.test")
    http.state = state  # type: ignore[attr-defined]
    http.monkeypatch = monkeypatch  # type: ignore[attr-defined]
    return http


def _directory_returns(monkeypatch, result):
    def fake(settings, username, password):
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(directory, "authenticate", fake)


# ------------------------------------------------------------- login flow ---


async def test_admin_gets_a_session(client):
    _directory_returns(client.monkeypatch, ADMIN)
    r = await client.post("/api/v1/auth/login", json={"username": "ada", "password": "pw"})
    assert r.status_code == 200
    body = r.json()
    assert body["principal"] == ADMIN.user_principal_name
    assert body["csrf_token"]

    cookie = r.cookies["odm_session"]
    assert cookie
    assert "HttpOnly" in r.headers["set-cookie"] and "Secure" in r.headers["set-cookie"]
    assert r.headers["x-frame-options"] == "DENY"

    me = await client.get("/api/v1/auth/session")
    assert me.status_code == 200
    assert me.json()["display_name"] == "Ada Admin"


async def test_non_member_is_refused(client):
    _directory_returns(client.monkeypatch, directory.NotAuthorized("not a member"))
    r = await client.post("/api/v1/auth/login", json={"username": "bob", "password": "pw"})
    assert r.status_code == 403
    assert "odm_session" not in r.cookies


async def test_bad_password_is_401_and_generic(client):
    _directory_returns(client.monkeypatch, directory.InvalidCredentials("invalidCredentials"))
    r = await client.post("/api/v1/auth/login", json={"username": "ada", "password": "wrong"})
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid credentials"


async def test_lockout_after_repeated_failures(client):
    client.state["failures"] = 5
    _directory_returns(client.monkeypatch, ADMIN)
    r = await client.post("/api/v1/auth/login", json={"username": "ada", "password": "pw"})
    assert r.status_code == 429
    assert r.headers["retry-after"]


async def test_session_required(client):
    assert (await client.get("/api/v1/auth/session")).status_code == 401


async def test_logout_needs_csrf_then_revokes(client):
    _directory_returns(client.monkeypatch, ADMIN)
    csrf = (
        await client.post("/api/v1/auth/login", json={"username": "ada", "password": "pw"})
    ).json()["csrf_token"]

    assert (await client.post("/api/v1/auth/logout")).status_code == 403
    assert (
        await client.post("/api/v1/auth/logout", headers={"X-ODM-CSRF": "wrong"})
    ).status_code == 403

    ok = await client.post("/api/v1/auth/logout", headers={"X-ODM-CSRF": csrf})
    assert ok.status_code == 204
    assert (await client.get("/api/v1/auth/session")).status_code == 401


async def test_cross_origin_state_change_is_rejected(client):
    _directory_returns(client.monkeypatch, ADMIN)
    r = await client.post(
        "/api/v1/auth/login",
        json={"username": "ada", "password": "pw"},
        headers={"Origin": "https://evil.example.org"},
    )
    assert r.status_code == 403
