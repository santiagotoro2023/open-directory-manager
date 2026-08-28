"""Every SQL statement, against a real PostgreSQL.

The rest of the suite fakes the pool, which means no statement is ever parsed
by a database: a query can be wrong in a way only PostgreSQL will tell you
about, and the first place that shows up is a running install. These tests
close that gap. Only the directory is faked here.

Set ODM_TEST_DATABASE_URL to a database this may create and drop tables in:

    docker run -d -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:17-alpine
    ODM_TEST_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \
        pytest tests/test_integration_db.py
"""

from __future__ import annotations

import os

import conftest  # noqa: F401  (environment setup ordering)
import httpx
import pytest

TEST_DB_URL = os.environ.get("ODM_TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not TEST_DB_URL, reason="ODM_TEST_DATABASE_URL is not set"
)


@pytest.fixture
async def fresh():
    """A database in exactly the state a fresh install is in.

    Rebuilt per test rather than truncated: migrations seed reference data
    (the built-in roles), and truncating it away would test against a state
    no real install is ever in."""
    import asyncpg

    from odm import db

    pool = await asyncpg.create_pool(
        TEST_DB_URL, min_size=1, max_size=4, server_settings={"search_path": "odm_test"}
    )
    try:
        async with pool.acquire() as conn:
            await conn.execute("DROP SCHEMA IF EXISTS odm_test CASCADE")
            await conn.execute("CREATE SCHEMA odm_test")
        await db.migrate(pool)
        yield pool
    finally:
        await pool.close()


@pytest.fixture
async def client(fresh, monkeypatch):
    from odm import directory
    from odm.main import create_app

    # The database is real; the directory is not. Endpoints that resolve a DN
    # or a SID read from the same sample tree the rest of the suite uses.
    monkeypatch.setattr(
        directory,
        "service_connection",
        lambda settings, read_only=True: conftest.FakeLdap(conftest.sample_directory()),
    )

    app = create_app()
    app.state.pool = fresh
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://odm.test"
    ) as http:
        http.monkeypatch = monkeypatch  # type: ignore[attr-defined]
        yield http


async def sign_in(client, user=None):
    from odm import directory

    user = user or conftest.ADMIN
    client.monkeypatch.setattr(
        directory, "authenticate", lambda settings, username, password: user
    )
    client.monkeypatch.setattr(
        directory, "authorize_principal", lambda settings, principal: user
    )
    response = await client.post(
        "/api/v1/auth/login", json={"username": user.sam_account_name, "password": "pw"}
    )
    assert response.status_code == 200, response.text
    client.headers["X-ODM-CSRF"] = response.json()["csrf_token"]
    return response


# ------------------------------------------------------------------ sign-in ---


async def test_signing_in_works_against_a_real_database(client):
    """The whole login path: rate-limit lookup, attempt record, session insert.

    This is the query that failed in a real install with
    AmbiguousParameterError, and no faked pool could have caught it."""
    await sign_in(client)

    async with client._transport.app.state.pool.acquire() as conn:
        attempts = await conn.fetchval("SELECT count(*) FROM login_attempt")
        sessions = await conn.fetchval("SELECT count(*) FROM admin_session")
    assert attempts == 1
    assert sessions == 1


async def test_a_wrong_password_is_recorded_and_counted(client):
    from odm import directory

    def refuse(settings, username, password):
        raise directory.InvalidCredentials("invalidCredentials")

    client.monkeypatch.setattr(directory, "authenticate", refuse)
    response = await client.post(
        "/api/v1/auth/login", json={"username": "ada", "password": "wrong"}
    )
    assert response.status_code == 401

    async with client._transport.app.state.pool.acquire() as conn:
        failed = await conn.fetchval(
            "SELECT count(*) FROM login_attempt WHERE succeeded = false"
        )
    assert failed == 1


async def test_repeated_failures_lock_the_account_out(client):
    """recent_failures counts by username and by source address; the source
    address is null over ASGI, which is exactly the case that broke."""
    from odm import directory

    def refuse(settings, username, password):
        raise directory.InvalidCredentials("invalidCredentials")

    client.monkeypatch.setattr(directory, "authenticate", refuse)
    codes = []
    for _ in range(7):
        response = await client.post(
            "/api/v1/auth/login", json={"username": "ada", "password": "wrong"}
        )
        codes.append(response.status_code)

    assert 429 in codes, f"never locked out: {codes}"


async def test_a_session_survives_a_second_request(client):
    await sign_in(client)
    response = await client.get("/api/v1/auth/session")
    assert response.status_code == 200, response.text


async def test_signing_out_revokes_the_session(client):
    await sign_in(client)
    assert (await client.post("/api/v1/auth/logout")).status_code in (200, 204)
    assert (await client.get("/api/v1/auth/session")).status_code == 401


# ------------------------------------------------- every read, for real SQL ---

def _readable_paths():
    """Every parameterless GET the console can call.

    Discovered rather than listed, so an endpoint added later is covered
    without anyone remembering to add it here. Included routers sit behind
    wrappers, so the walk has to follow original_router.
    """
    from fastapi.routing import APIRoute

    from odm.main import create_app

    def walk(router, out):
        for route in router.routes:
            if isinstance(route, APIRoute):
                out.append(route)
            inner = getattr(route, "original_router", None)
            if inner is not None:
                walk(inner, out)
        return out

    routes = walk(create_app(), [])
    return sorted(
        {
            route.path
            for route in routes
            if "GET" in route.methods
            and "{" not in route.path
            # Machine-authenticated, and not part of the console.
            and not route.path.startswith("/api/v1/agent/")
        }
    )


READ_ENDPOINTS = _readable_paths()


def test_enough_routes_were_discovered():
    """A broken walk would silently reduce this suite to nothing."""
    assert len(READ_ENDPOINTS) > 25, READ_ENDPOINTS


@pytest.mark.parametrize("path", READ_ENDPOINTS)
async def test_reads_execute_their_sql(client, path):
    """A 500 is a broken query or an unhandled error. An endpoint that needs
    Samba, Kea or a CA that is not installed should answer 503 or 409 — those
    are answers; a 500 is not."""
    await sign_in(client)
    response = await client.get(path)
    assert response.status_code != 500, f"{path}: {response.text[:500]}"


async def test_the_audit_log_records_and_reads_back(client):
    """Audit is written on every change and read through a filter, so it
    exercises both directions with real values."""
    from odm import audit

    await sign_in(client)
    async with client._transport.app.state.pool.acquire() as conn:
        await audit.record(
            conn,
            actor="ada",
            actor_sid=conftest.ADMIN.sid,
            source_ip="192.0.2.10",
            action="test.write",
            outcome="success",
            object_type="user",
            object_dn=f"CN=x,{conftest.BASE_DN}",
            detail="written by the integration suite",
        )

    response = await client.get("/api/v1/audit")
    assert response.status_code == 200, response.text
    actions = [entry["action"] for entry in response.json()["entries"]]
    assert "test.write" in actions


# ------------------------------------------- every statement, not just those
# ------------------------------------------- an endpoint above happens to run


def _sql_literals():
    """SQL string literals in the control plane, with where they came from."""
    import ast
    import pathlib
    import re

    looks_like_sql = re.compile(
        r"^\s*(SELECT\s.*\sFROM\s|INSERT\s+INTO\s|UPDATE\s.*\sSET\s"
        r"|DELETE\s+FROM\s|WITH\s.*\sAS\s*\()",
        re.I | re.S,
    )
    for path in sorted(pathlib.Path("odm").glob("*.py")):
        tree = ast.parse(path.read_text(), str(path))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and looks_like_sql.match(node.value)
            ):
                yield f"{path.name}:{node.lineno}", node.value


async def test_every_statement_parses_against_the_real_schema(fresh):
    """PREPARE is where PostgreSQL reports an unknown column, an untypeable
    parameter or a syntax error. Endpoint tests only reach the statements
    their endpoint runs; this reaches all of them."""
    statements = list(_sql_literals())
    assert len(statements) > 80, f"only found {len(statements)} statements; extractor broke"

    broken = []
    async with fresh.acquire() as conn:
        for where, sql in statements:
            try:
                await conn.prepare(sql)
            except Exception as exc:  # noqa: BLE001 - reporting every failure
                broken.append(f"{where}  {type(exc).__name__}: {str(exc).splitlines()[0]}")

    assert not broken, "statements PostgreSQL rejects:\n" + "\n".join(broken)


async def test_the_built_in_roles_survive_a_migration(client):
    """Reference data the migrations seed has to actually be there: the
    delegation UI lists these, and an assignment cannot be made without one."""
    await sign_in(client)
    response = await client.get("/api/v1/rbac/roles")
    assert response.status_code == 200, response.text
    names = [role["name"] for role in response.json()["roles"]]
    assert names, "the migrations seeded no roles"
    return names


async def test_a_write_round_trips_arrays_and_audit(client):
    """Writes convert Python values into PostgreSQL types — text[] for a
    role's permissions, inet for an address. PREPARE cannot catch a bad
    conversion; only executing one can."""
    await sign_in(client)

    roles = (await client.get("/api/v1/rbac/roles")).json()["roles"]
    role_name = roles[0]["name"]

    created = await client.post(
        "/api/v1/rbac/assignments",
        json={
            "role_name": role_name,
            "principal_dn": f"CN=Helpdesk,OU=Example Corp,{conftest.BASE_DN}",
            "scope_dn": f"OU=Example Corp,{conftest.BASE_DN}",
            "description": "written by the integration suite",
        },
    )
    assert created.status_code == 201, created.text

    listed = await client.get("/api/v1/rbac/assignments")
    assert listed.status_code == 200, listed.text
    assert any(
        a["role_name"] == role_name for a in listed.json()["assignments"]
    ), listed.text

    # The change must be in the audit log, which is a second table and a
    # second set of conversions.
    audit_entries = (await client.get("/api/v1/audit")).json()["entries"]
    assert any(e["action"] == "rbac.assign" for e in audit_entries), audit_entries
