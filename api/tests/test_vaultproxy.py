"""The vault under the console's address: what is forwarded, to where, and
what the console's own gates leave alone."""

from __future__ import annotations

import conftest
import httpx
import pytest
from starlette.testclient import TestClient

from odm import ca, vaultproxy
from odm.main import create_app


@pytest.fixture
def console(state, monkeypatch, tmp_path):
    app = create_app()
    app.state.pool = conftest.FakePool(state)
    seen: list[httpx.Request] = []

    async def fetchval(self, sql, *args):
        if "role_name = 'password-manager'" in sql:
            return "vault-node.corp.example.internal" if state.get("installed") else None
        return None

    monkeypatch.setattr(conftest.FakePool, "fetchval", fetchval)
    monkeypatch.setattr(ca, "initialised", lambda settings: state.get("ca", True))
    monkeypatch.setattr(ca, "cert_path", lambda settings: tmp_path / "ca.pem")

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200, headers={"content-type": "text/html", "x-upstream": "vaultwarden"},
            stream=httpx.ByteStream(b"<html>vault</html>"),
        )

    monkeypatch.setattr(
        vaultproxy, "_clients",
        {str(tmp_path / "ca.pem"): httpx.AsyncClient(transport=httpx.MockTransport(upstream))},
    )
    return TestClient(app, base_url="https://odm.corp.example.internal"), seen, state


def test_the_vault_is_forwarded_to_the_node_with_its_own_headers_kept(console):
    client, seen, state = console
    state["installed"] = True
    response = client.get("/vault/", headers={"cookie": "vault=1"})
    assert response.status_code == 200 and response.text == "<html>vault</html>"
    assert seen[-1].url == "https://vault-node.corp.example.internal:8222/vault/"
    assert seen[-1].headers["x-forwarded-proto"] == "https"
    assert seen[-1].headers["cookie"] == "vault=1"
    assert seen[-1].headers["host"] == "odm.corp.example.internal"
    # The vault's headers, not the console's: no console policy, framable by it.
    assert response.headers["x-upstream"] == "vaultwarden"
    assert response.headers["x-frame-options"] == "SAMEORIGIN"
    assert "script-src 'self'" not in response.headers.get("content-security-policy", "")

    # The extension's cross-origin API calls are the vault's to judge.
    response = client.post(
        "/vault/api/sync", headers={"origin": "moz-extension://abc"}, content=b"{}"
    )
    assert response.status_code == 200
    assert seen[-1].method == "POST" and seen[-1].url.path == "/vault/api/sync"

    assert client.get("/vault", follow_redirects=False).headers["location"].endswith("/vault/")


def test_without_the_role_or_the_authority_nothing_is_forwarded(console):
    client, seen, state = console
    assert client.get("/vault/").status_code == 503
    state["installed"] = True
    state["ca"] = False
    response = client.get("/vault/")
    assert response.status_code == 503 and "authority" in response.text
    assert seen == []
