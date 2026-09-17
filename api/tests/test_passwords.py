"""The password manager, managed from the console: what the page is told,
what the setup checks, and what a collection's access looks like."""

from __future__ import annotations

import conftest
import pytest
from starlette.testclient import TestClient

from odm import directory, vaultkeeper
from odm.main import create_app
from odm.routes_passwords import AccessRequest, CollectionRequest, SeatsConfig

ROW = {
    "vault_url": "", "org_client_id": "", "org_client_secret": "", "sync_account": "",
    "sync_password": "", "sync_groups": "[]", "sync_every_hours": 1, "smtp_host": "",
    "smtp_port": 587, "smtp_from": "", "smtp_username": "", "smtp_password": "",
    "admin_token": "", "last_applied_at": None, "last_result": "", "updated_at": None,
    "node_fqdn": "", "sso_enabled": True, "sso_only": True, "sso_client_id": "",
    "sso_client_secret": "", "owner_account": "", "owner_password": "", "org_id": "",
    "org_key": "", "org_name": "", "seat_users": "[]", "members": "[]", "last_sync_at": None,
    "last_sync_result": "", "sync_requested": False,
}


@pytest.fixture
def console(state, monkeypatch) -> TestClient:
    app = create_app()
    app.state.pool = conftest.FakePool(state)
    monkeypatch.setattr(
        directory, "authenticate", lambda settings, username, password: conftest.ADMIN
    )
    original_fetchrow = conftest.FakeConn.fetchrow
    original_fetchval = conftest.FakeConn.fetchval
    original_fetch = conftest.FakePool.fetch

    async def fetchrow(self, sql, *args):
        if "FROM password_manager" in sql:
            return dict(ROW)
        return await original_fetchrow(self, sql, *args)

    async def fetchval(self, sql, *args):
        if "role_name = 'password-manager'" in sql:
            return "vault.corp.example.internal" if state.get("installed") else None
        return await original_fetchval(self, sql, *args)

    async def fetch(self, sql, *args):
        if "FROM vault_collection" in sql:
            return []
        return await original_fetch(self, sql, *args)

    monkeypatch.setattr(conftest.FakeConn, "fetchrow", fetchrow)
    monkeypatch.setattr(conftest.FakeConn, "fetchval", fetchval)
    monkeypatch.setattr(conftest.FakePool, "fetch", fetch)
    client = TestClient(app, base_url="https://odm.corp.example.internal")
    response = client.post("/api/v1/auth/login", json={"username": "ada", "password": "pw"})
    assert response.status_code == 200, response.text
    client.headers["X-ODM-CSRF"] = response.json()["csrf_token"]
    client.headers["Origin"] = "https://odm.corp.example.internal"
    return client


def test_status_says_whether_the_role_exists_and_where(console, state):
    body = console.get("/api/v1/passwords").json()
    assert body["installed"] is False and body["ready"] is False
    # The vault's address is the console's, whichever server carries it.
    assert body["vault_url"] == "https://odm.corp.example.internal:8443/vault"
    state["installed"] = True
    body = console.get("/api/v1/passwords").json()
    assert body["installed"] is True
    assert body["collections"] == [] and body["members"] == []


def test_setup_needs_the_authority_and_a_node(console, monkeypatch):
    monkeypatch.setattr("odm.routes_passwords.ca.initialised", lambda settings: False)
    response = console.post("/api/v1/passwords/setup", json={"seat_groups": ["%Sales"]})
    assert response.status_code == 400 and "certificate authority" in response.text


def test_the_requests_are_validated():
    with pytest.raises(ValueError):
        SeatsConfig(seat_groups=["bad\\group"])
    ok = SeatsConfig(seat_groups=["%Sales", "Sales"], seat_users=["%ada"])
    assert ok.seat_groups == ["Sales"] and ok.seat_users == ["ada"]
    with pytest.raises(ValueError):
        CollectionRequest(name="Sales\nX")
    assert AccessRequest(group_name="%Finance", read_only=True).group_name == "Finance"


def test_json_lists_survive_both_shapes():
    assert vaultkeeper._json_list('["a", "b"]') == ["a", "b"]
    assert vaultkeeper._json_list(["a"]) == ["a"]
    assert vaultkeeper._json_list(None) == []
