"""The password-manager role's configuration."""

from __future__ import annotations

import conftest  # noqa: F401  (environment setup ordering)
import pytest
from starlette.testclient import TestClient

from odm import directory
from odm.main import create_app
from odm.routes_passwords import PasswordManagerConfig

ROW = {
    "vault_url": "", "org_client_id": "", "org_client_secret": "", "sync_account": "",
    "sync_password": "", "sync_groups": "[]", "sync_every_hours": 1, "smtp_host": "",
    "smtp_port": 587, "smtp_from": "", "smtp_username": "", "smtp_password": "",
    "admin_token": "", "last_applied_at": None, "last_result": "", "updated_at": None,
    "node_fqdn": "", "sso_enabled": True, "sso_only": True, "sso_client_id": "",
    "sso_client_secret": "",
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

    async def fetchrow(self, sql, *args):
        if "FROM password_manager" in sql:
            return dict(ROW)
        return await original_fetchrow(self, sql, *args)

    async def fetchval(self, sql, *args):
        if "role_name = 'password-manager'" in sql:
            return "vault.corp.example.internal" if state.get("installed") else None
        return await original_fetchval(self, sql, *args)

    monkeypatch.setattr(conftest.FakeConn, "fetchrow", fetchrow)
    monkeypatch.setattr(conftest.FakeConn, "fetchval", fetchval)
    client = TestClient(app, base_url="https://odm.corp.example.internal")
    response = client.post("/api/v1/auth/login", json={"username": "ada", "password": "pw"})
    assert response.status_code == 200, response.text
    client.headers["X-ODM-CSRF"] = response.json()["csrf_token"]
    client.headers["Origin"] = "https://odm.corp.example.internal"
    return client


def test_status_says_whether_the_role_exists_and_where(console, state):
    body = console.get("/api/v1/passwords").json()
    assert body["installed"] is False and body["vault_url"] == ""
    state["installed"] = True
    body = console.get("/api/v1/passwords").json()
    assert body["installed"] is True
    assert body["vault_url"] == "https://vault.corp.example.internal"
    assert body["org_configured"] is False


def test_configuring_without_a_node_is_refused(console):
    response = console.put(
        "/api/v1/passwords", json={"vault_url": "https://vault.corp.example.internal"}
    )
    assert response.status_code == 400
    assert "not installed" in response.text


def test_the_configuration_is_validated():
    with pytest.raises(ValueError):
        PasswordManagerConfig(vault_url="http://plain.example")
    with pytest.raises(ValueError):
        PasswordManagerConfig(sync_groups=["bad\\group"])
    ok = PasswordManagerConfig(vault_url="https://vault.example/", sync_groups=["%Sales"])
    assert ok.vault_url == "https://vault.example" and ok.sync_groups == ["Sales"]
