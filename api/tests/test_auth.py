"""Phase 1 gate: only members of the admin group get a session."""

from __future__ import annotations

import pytest
from conftest import ADMIN

from odm import directory, sessions
from odm.config import derive_base_dn, get_settings
from odm.directory import InvalidCredentials, nested_groups_filter, validate_username


def _directory_returns(monkeypatch, result):
    def fake(settings, username, password):
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(directory, "authenticate", fake)


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


def test_nested_groups_filter_escapes_and_walks_nesting():
    filt = nested_groups_filter("CN=a*b,DC=x")
    assert "1.2.840.113556.1.4.1941" in filt
    assert "a*b" not in filt and r"a\2ab" in filt


def test_object_sid_is_rendered_not_stringified_bytes():
    """objectSid arrives as a binary blob; a str() of it is useless."""
    # revision, sub-authority count, 6-byte identifier authority, then the
    # sub-authorities little-endian: S-1-5-21-1-2-3-1104.
    raw = bytes([1, 5, 0, 0, 0, 0, 0, 5]) + b"".join(
        value.to_bytes(4, "little") for value in (21, 1, 2, 3, 1104)
    )
    assert directory.read_sid(raw) == "S-1-5-21-1-2-3-1104"
    assert directory.read_sid(None) is None


def test_empty_password_never_reaches_the_dc():
    # An empty password is an LDAP unauthenticated bind, which succeeds.
    with pytest.raises(InvalidCredentials):
        directory.authenticate(get_settings(), "ada", "")


def test_should_lock():
    assert not sessions.should_lock(4, 5)
    assert sessions.should_lock(5, 5)


# ------------------------------------------------------------- login flow ---


async def test_admin_gets_a_session(client):
    _directory_returns(client.monkeypatch, ADMIN)
    r = await client.post("/api/v1/auth/login", json={"username": "ada", "password": "pw"})
    assert r.status_code == 200
    body = r.json()
    assert body["principal"] == ADMIN.user_principal_name
    assert body["csrf_token"]

    assert r.cookies["odm_session"]
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


async def test_lost_membership_revokes_the_session_mid_flight(admin_client, ldap):
    """A privileged route re-proves group membership and revokes on loss."""
    admin_client.state["admin_stale"] = True
    admin_client.monkeypatch.setattr(
        directory,
        "authorize_principal",
        lambda settings, upn: (_ for _ in ()).throw(directory.NotAuthorized("removed")),
    )
    r = await admin_client.get("/api/v1/directory/tree")
    assert r.status_code == 403
    assert (await admin_client.get("/api/v1/auth/session")).status_code == 401
