"""The console as an OpenID Connect provider: the code flow, end to end,
against an in-memory copy of the provider's tables."""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import conftest
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers
from starlette.testclient import TestClient

from odm import directory, oidc
from odm.config import get_settings
from odm.main import create_app

VAULT = "https://vault.corp.example.internal"
REDIRECT = f"{VAULT}/identity/connect/oidc-signin"


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class Store:
    """Just enough of Postgres for oidc.py's statements."""

    def __init__(self) -> None:
        self.key: dict | None = None
        self.clients: dict[str, dict] = {}
        self.codes: dict[str, dict] = {}
        self.tokens: dict[str, dict] = {}

    async def fetchrow(self, sql, *args):
        if "FROM oidc_key" in sql:
            return self.key
        if "FROM oidc_client" in sql:
            return self.clients.get(args[0])
        if "DELETE FROM oidc_code" in sql and "RETURNING" in sql:
            row = self.codes.pop(args[0], None)
            return row if row and row["client_id"] == args[1] else None
        if "DELETE FROM oidc_token" in sql and "RETURNING" in sql:
            row = self.tokens.pop(args[0], None)
            return row if row and row["kind"] == "refresh" and row["client_id"] == args[1] else None
        if "SELECT claims FROM oidc_token" in sql:
            row = self.tokens.get(args[0])
            return row if row and row["kind"] == "access" else None
        return None

    async def execute(self, sql, *args):
        if "INSERT INTO oidc_key" in sql:
            self.key = {"kid": args[0], "private_pem": args[1]}
        elif "INSERT INTO oidc_client" in sql:
            self.clients[args[0]] = {
                "client_id": args[0], "name": args[1], "secret_hash": args[2],
                "redirect_uris": json.loads(args[3]),
            }
        elif "INSERT INTO oidc_code" in sql:
            self.codes[args[0]] = {
                "code": args[0], "client_id": args[1], "redirect_uri": args[2], "nonce": args[3],
                "code_challenge": args[4], "claims": json.loads(args[5]),
                "expires_at": datetime.now(UTC) + timedelta(seconds=int(args[6])),
            }
        elif "INSERT INTO oidc_token" in sql:
            access, client_id, claims, nonce, scope, _lifetime, refresh, _ = args
            for token, kind in ((access, "access"), (refresh, "refresh")):
                self.tokens[token] = {
                    "token": token, "kind": kind, "client_id": client_id,
                    "claims": json.loads(claims), "nonce": nonce, "scope": scope,
                }
        return "OK"


@pytest.fixture
def provider(state, monkeypatch):
    store = Store()
    app = create_app()
    app.state.pool = conftest.FakePool(state)
    original_fetchrow = conftest.FakeConn.fetchrow
    original_execute = conftest.FakeConn.execute
    original_pool_fetchrow = conftest.FakePool.fetchrow
    original_pool_execute = conftest.FakePool.execute

    async def conn_fetchrow(self, sql, *args):
        if "oidc_" in sql:
            return await store.fetchrow(sql, *args)
        return await original_fetchrow(self, sql, *args)

    async def conn_execute(self, sql, *args):
        if "oidc_" in sql:
            return await store.execute(sql, *args)
        return await original_execute(self, sql, *args)

    async def pool_fetchrow(self, sql, *args):
        if "oidc_" in sql:
            return await store.fetchrow(sql, *args)
        return await original_pool_fetchrow(self, sql, *args)

    async def pool_execute(self, sql, *args):
        if "oidc_" in sql:
            return await store.execute(sql, *args)
        return await original_pool_execute(self, sql, *args)

    monkeypatch.setattr(conftest.FakeConn, "fetchrow", conn_fetchrow)
    monkeypatch.setattr(conftest.FakeConn, "execute", conn_execute)
    monkeypatch.setattr(conftest.FakePool, "fetchrow", pool_fetchrow)
    monkeypatch.setattr(conftest.FakePool, "execute", pool_execute)
    monkeypatch.setattr(oidc, "KEY_BITS", 2048)  # the test suite is not a key ceremony

    person = directory.DirectoryUser(
        dn=f"CN=sam,OU=Example Corp,{conftest.BASE_DN}", sam_account_name="sam",
        user_principal_name="sam@CORP.EXAMPLE.INTERNAL", display_name="Sam Sales",
        sid="S-1-5-21-1-2-3-1201", mail="Sam.Sales@corp.example.internal",
    )

    def authenticate(settings, username, password):
        if username == "sam" and password == "right":
            return person
        raise directory.InvalidCredentials("wrong password")

    monkeypatch.setattr(directory, "authenticate", authenticate)
    client = TestClient(app, base_url="https://odm.corp.example.internal")
    client.headers["Origin"] = "https://odm.corp.example.internal"
    return client, store


def _register(store: Store) -> str:
    secret = secrets.token_urlsafe(16)
    store.clients["password-manager"] = {
        "client_id": "password-manager", "name": "the password manager",
        "secret_hash": hashlib.sha256(secret.encode()).hexdigest(), "redirect_uris": [REDIRECT],
    }
    return secret


def test_discovery_names_the_console_as_issuer(provider):
    client, _ = provider
    body = client.get("/api/v1/oidc/.well-known/openid-configuration").json()
    assert body["issuer"].endswith("/api/v1/oidc")
    assert body["authorization_endpoint"] == body["issuer"] + "/authorize"
    assert "S256" in body["code_challenge_methods_supported"]


def test_the_code_flow_signs_a_person_in_with_their_domain_account(provider):
    client, store = provider
    secret = _register(store)
    verifier = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=")
    params = {
        "client_id": "password-manager", "redirect_uri": REDIRECT, "response_type": "code",
        "scope": "openid profile email", "state": "xyz", "nonce": "n0nce",
        "code_challenge": challenge.decode(), "code_challenge_method": "S256",
    }

    # No ticket, no keytab in the test: the page itself, with its own policy.
    page = client.get("/api/v1/oidc/authorize", params=params)
    assert page.status_code == 200
    assert "Sign in to the password manager" in page.text
    assert 'name="password"' in page.text
    csp = page.headers["content-security-policy"]
    assert f"form-action 'self' {VAULT}" in csp and "style-src 'nonce-" in csp

    wrong = client.post(
        "/api/v1/oidc/authorize", data={**params, "username": "sam", "password": "no"}
    )
    assert wrong.status_code == 200 and "wrong" in wrong.text

    done = client.post(
        "/api/v1/oidc/authorize", data={**params, "username": "sam", "password": "right"},
        follow_redirects=False,
    )
    assert done.status_code == 303
    location = urlsplit(done.headers["location"])
    assert location.scheme + "://" + location.netloc + location.path == REDIRECT
    query = parse_qs(location.query)
    assert query["state"] == ["xyz"]
    code = query["code"][0]

    # A client that is not the registered one gets nothing for the code.
    bad = client.post(
        "/api/v1/oidc/token",
        data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
              "code_verifier": verifier},
        auth=("password-manager", "not-the-secret"),
    )
    assert bad.status_code == 401

    tokens = client.post(
        "/api/v1/oidc/token",
        data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
              "code_verifier": verifier},
        auth=("password-manager", secret),
    ).json()
    assert tokens["token_type"] == "Bearer" and tokens["refresh_token"]

    # The id token: signed by the published key, about the right person.
    header, payload, signature = tokens["id_token"].split(".")
    claims = json.loads(_unb64(payload))
    assert claims["nonce"] == "n0nce" and claims["aud"] == "password-manager"
    assert claims["email"] == "sam.sales@corp.example.internal" and claims["email_verified"] is True
    assert claims["sub"] == "S-1-5-21-1-2-3-1201" and claims["preferred_username"] == "sam"
    jwk = client.get("/api/v1/oidc/jwks").json()["keys"][0]
    assert jwk["kid"] == json.loads(_unb64(header))["kid"]
    public = RSAPublicNumbers(
        int.from_bytes(_unb64(jwk["e"]), "big"), int.from_bytes(_unb64(jwk["n"]), "big")
    ).public_key()
    assert isinstance(public, rsa.RSAPublicKey)
    public.verify(
        _unb64(signature), f"{header}.{payload}".encode(), padding.PKCS1v15(), hashes.SHA256()
    )

    # The code was one use.
    again = client.post(
        "/api/v1/oidc/token",
        data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
              "code_verifier": verifier},
        auth=("password-manager", secret),
    )
    assert again.status_code == 400 and again.json()["error"] == "invalid_grant"

    info = client.get(
        "/api/v1/oidc/userinfo", headers={"Authorization": "Bearer " + tokens["access_token"]}
    ).json()
    assert info["email"] == "sam.sales@corp.example.internal"

    refreshed = client.post(
        "/api/v1/oidc/token",
        data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]},
        auth=("password-manager", secret),
    ).json()
    assert refreshed["id_token"] and refreshed["access_token"] != tokens["access_token"]


def test_an_unregistered_redirect_or_a_wrong_verifier_is_refused(provider):
    client, store = provider
    secret = _register(store)
    params = {
        "client_id": "password-manager", "redirect_uri": "https://elsewhere.example/cb",
        "response_type": "code", "scope": "openid",
    }
    assert client.get("/api/v1/oidc/authorize", params=params).status_code == 400

    params["redirect_uri"] = REDIRECT
    params.update({"code_challenge": "a" * 43, "code_challenge_method": "S256"})
    done = client.post(
        "/api/v1/oidc/authorize", data={**params, "username": "sam", "password": "right"},
        follow_redirects=False,
    )
    code = parse_qs(urlsplit(done.headers["location"]).query)["code"][0]
    response = client.post(
        "/api/v1/oidc/token",
        data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
              "code_verifier": "not-it"},
        auth=("password-manager", secret),
    )
    assert response.status_code == 400 and "verifier" in response.json()["error_description"]


def test_claims_fall_back_to_the_account_name_at_the_domain():
    settings = get_settings()
    user = directory.DirectoryUser(
        dn="CN=x", sam_account_name="Sam", user_principal_name="sam@X", display_name="Sam", sid=None
    )
    claims = oidc.claims_for(settings, user)
    assert claims["email"] == f"sam@{settings.domain}" and claims["sub"] == "sam@X"
