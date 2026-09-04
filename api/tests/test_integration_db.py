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
            if not (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and looks_like_sql.match(node.value)
            ):
                continue
            # An f-string arrives here one literal part at a time, so a
            # statement whose table name is interpolated shows up as a
            # fragment that stops mid-identifier. It is not a statement and
            # cannot be prepared: what table it names is decided at runtime,
            # from the schema itself.
            if node.value.count('"') % 2:
                continue
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


async def test_a_task_nobody_collects_stops_a_role_saying_installing(fresh):
    """A machine that never comes back left its role saying "installing" for
    ever, with no way to retry it and nothing on screen saying why.

    Exercised through the real tables because the whole of it is SQL: the
    state transition, the array of returned rows, and the join back onto the
    thing that was waiting."""
    from odm import tasks

    async with fresh.acquire() as conn:
        role_id = await conn.fetchval(
            """
            INSERT INTO server_role (role_name, node_fqdn, state, config, installed_by)
            VALUES ('dhcp', 'reaped.example.org', 'installing', '{}'::jsonb, 'suite')
            RETURNING id
            """
        )
        task_id = await tasks.enqueue(
            conn,
            node_fqdn="reaped.example.org",
            kind="role-install",
            payload={"role": "dhcp", "arguments": [], "password": "not stored"},
            subject=str(role_id),
            requested_by="suite",
        )

        # Fresh work is left alone; an agent that is slow is not an agent
        # that is gone.
        await tasks.reap(conn)
        assert await conn.fetchval(
            "SELECT state FROM server_role WHERE id = $1", role_id
        ) == "installing"

        await conn.execute(
            "UPDATE node_task SET created_at = now() - interval '2 hours' WHERE id = $1::uuid",
            task_id,
        )
        await tasks.reap(conn)

        assert await conn.fetchval(
            "SELECT state FROM node_task WHERE id = $1::uuid", task_id
        ) == "failed"
        state, error = await conn.fetchrow(
            "SELECT state, last_error FROM server_role WHERE id = $1", role_id
        )
        assert state == "failed"
        assert "odm-agent" in error, error
        # A password travels in a task only until the machine has it.
        payload = await conn.fetchval(
            "SELECT payload FROM node_task WHERE id = $1::uuid", task_id
        )
        assert "password" not in payload, payload




async def test_a_session_report_is_stored_and_read_back_for_that_person(fresh):
    """What happens when somebody's policy is applied — their drive maps,
    their connection files — was reported nowhere, so a drive that did not
    mount existed only in the machine's journal. The session reports it under
    the person, and their page asks for it by account name."""
    from odm import db, routes_policy

    dn = "CN=WS-01,CN=Computers,DC=corp,DC=example,DC=internal"
    async with fresh.acquire() as conn:
        # The machine's own report, and one from a session on it.
        for username, results in (
            (None, [{"setting": "files:/etc/issue.net", "status": "success", "reason": ""}]),
            (
                "terry.tester",
                [
                    {
                        "setting": "drive_maps:firmendaten",
                        "status": "failed",
                        "reason": "mount error(126): Required key not available",
                    },
                    {"setting": "remote_desktop_files:Terminal Server", "status": "success",
                     "reason": ""},
                ],
            ),
        ):
            await conn.execute(
                """
                INSERT INTO agent_report (computer_dn, hostname, agent_version, policy_serial,
                                          applied_gpos, results, failures, username)
                VALUES ($1, 'ws-01.corp.example.internal', '0.7.6', 'abc',
                        '[]'::jsonb, $2::jsonb, $3, $4)
                """,
                dn,
                db.dumps(results),
                sum(1 for result in results if result["status"] == "failed"),
                username,
            )

    # The person's page asks by account name and gets their session, with the
    # reason a mount failed rather than a bare status.
    sessions = await routes_policy.reports(pool=fresh, username="TERRY.TESTER")
    assert len(sessions["reports"]) == 1, sessions
    report = sessions["reports"][0]
    assert report["username"] == "terry.tester"
    assert report["failures"] == 1
    reasons = {row["setting"]: row["reason"] for row in report["results"]}
    assert "Required key not available" in reasons["drive_maps:firmendaten"]

    # The machine's page asks for the machine's own and does not get the
    # session's: "did this machine apply its policy" is a different question.
    machine = await routes_policy.reports(pool=fresh, computer_dn=dn)
    assert len(machine["reports"]) == 1, machine
    assert machine["reports"][0]["results"][0]["setting"] == "files:/etc/issue.net"


async def test_replication_comes_from_the_controllers_that_reported_it(fresh):
    """Samba refuses the call behind `samba-tool drs showrepl` to anything
    below domain-controller level, so the control plane's own account can never
    read replication state — it used to report that as a missing right and
    point at a script that could not grant it. Each controller collects its own
    state with its inventory instead."""
    from test_operations import SHOWREPL

    from odm import routes_dc
    from odm.config import get_settings

    dn = "CN=DC1,OU=Domain Controllers,DC=corp,DC=example,DC=internal"
    controllers = [{"distinguished_name": dn, "name": "DC1"}]
    settings = get_settings()

    # Nothing reported: the page says so rather than showing an error about
    # rights, and asking here is the fallback.
    empty = await routes_dc._replication(fresh, settings, controllers)
    assert empty.get("servers") == [] or empty.get("available") is False

    async with fresh.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO computer_fact (computer_dn, hostname, replication, replication_at)
            VALUES ($1, $2, $3, now())
            """,
            dn,
            "dc1.corp.example.internal",
            SHOWREPL,
        )

    status = await routes_dc._replication(fresh, settings, controllers)
    assert status["source"] == "agent"
    assert status["servers"] == ["dc1.corp.example.internal"]
    assert status["collected_at"] is not None
    # Two inbound partnerships in the fixture, one of them failing, and each
    # row says which controller saw it.
    assert len(status["inbound"]) == 2
    assert {entry["on"] for entry in status["inbound"]} == {"dc1.corp.example.internal"}
    assert status["healthy"] is False


async def test_a_machine_that_reports_only_its_inventory_counts_as_alive(fresh):
    """A policy report is posted by a run that applied something, and policy
    already applied is not applied again — so a settled machine posts none for
    as long as nothing changes. Judged by that alone the console said "has
    never reported in, so it is probably not running the agent" over machines
    checking in every fifteen minutes, and refused to install a role on them.
    """
    from odm import agents, tasks

    dn = "CN=WS-01,CN=Computers,DC=example,DC=org"
    async with fresh.acquire() as conn:
        # Nothing at all: this one really has never run the agent.
        assert await agents.last_contact(fresh) == {}

        await conn.execute(
            "INSERT INTO computer_fact (computer_dn, hostname) VALUES ($1, $2)",
            dn,
            "ws-01.example.org",
        )
        contact = (await agents.last_contact(fresh))[dn.lower()]
        assert contact.how == "inventory"
        assert contact.policy_run is None
        assert agents.describe(contact)["last_seen"] == contact.at
        assert (await agents.freshness(fresh, 60))["fresh"] == 1

        # Collecting queued work is contact too, and it is the machine itself
        # that claims it.
        await tasks.enqueue(
            conn,
            node_fqdn="ws-01.example.org",
            kind="policy-refresh",
            payload={},
            requested_by="suite",
        )
        await tasks.claim(conn, "ws-01.example.org")
        assert (await agents.last_contact(fresh))[dn.lower()].how == "queued work"

        # And a policy run is reported next to the last contact, not instead
        # of it.
        await conn.execute(
            """
            INSERT INTO agent_report (computer_dn, hostname, agent_version, policy_serial,
                                      applied_gpos, results, failures)
            VALUES ($1, $2, '0.0.0', 'abc', '[]'::jsonb, '[]'::jsonb, 0)
            """,
            dn,
            "ws-01.example.org",
        )
        contact = (await agents.last_contact(fresh))[dn.lower()]
        assert contact.how == "policy report"
        assert contact.policy_run is not None

        # A machine nobody has heard from is still nobody: no row, no guess.
        assert "cn=ws-02,cn=computers,dc=example,dc=org" not in await agents.last_contact(fresh)


async def test_a_policy_change_reaches_machines_only_when_the_domain_pushes(fresh):
    """Push is a domain setting and off by default: a policy edit must not
    queue work for every machine in the domain unless somebody turned it on.

    All of it is SQL — the schedule row, the machines that have reported, and
    the check for a refresh already waiting — so it runs against the real
    schema."""
    from odm import tasks

    async with fresh.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO computer_fact (computer_dn, hostname) VALUES
                ('CN=WS-01,CN=Computers,DC=example,DC=org', 'ws-01.example.org'),
                ('CN=WS-02,CN=Computers,DC=example,DC=org', 'ws-02.example.org')
            """
        )

        # Off, which is how the domain starts.
        assert await tasks.push_policy(conn, "suite") == 0
        assert await conn.fetchval("SELECT count(*) FROM node_task") == 0

        await conn.execute("UPDATE agent_schedule SET push_enabled = true")
        assert await tasks.push_policy(conn, "suite") == 2
        kinds = await conn.fetch("SELECT kind, node_fqdn FROM node_task ORDER BY node_fqdn")
        assert [row["kind"] for row in kinds] == ["policy-refresh", "policy-refresh"]

        # A second edit while the first refresh is still waiting does not
        # leave a machine a queue of identical refreshes to work through.
        assert await tasks.push_policy(conn, "suite") == 0
        assert await conn.fetchval("SELECT count(*) FROM node_task") == 2


async def test_the_agent_schedule_holds_one_row_and_only_the_four_intervals(fresh):
    """The interval an agent polls on is a domain setting with four values.
    Anything else is a machine that polls on something nobody chose."""
    async with fresh.acquire() as conn:
        assert await conn.fetchrow("SELECT poll_minutes, push_enabled FROM agent_schedule") == (
            15,
            False,
        )
        import asyncpg

        with pytest.raises(asyncpg.exceptions.CheckViolationError):
            await conn.execute("UPDATE agent_schedule SET poll_minutes = 7")


async def test_a_certificate_profile_round_trips_its_purpose_array(client):
    """purposes is text[]; PREPARE cannot tell whether Python's list survives
    the conversion, and the issue route reads it straight back out."""
    await sign_in(client)

    created = await client.post(
        "/api/v1/ca/profiles",
        json={
            "name": "mail-gateway",
            "description": "TLS and S/MIME",
            "purposes": ["server", "email"],
            "validity_days": 365,
            "key_size": 3072,
        },
    )
    assert created.status_code == 201, created.text

    listed = (await client.get("/api/v1/ca/profiles")).json()
    mine = [one for one in listed["profiles"] if one["name"] == "mail-gateway"]
    assert mine and mine[0]["purposes"] == ["server", "email"], listed
    assert not mine[0]["built_in"]
    # The built-in pair is always offered alongside.
    assert {"server", "client"} <= {one["name"] for one in listed["profiles"]}

    removed = await client.request("DELETE", "/api/v1/ca/profiles?name=mail-gateway")
    assert removed.status_code == 204, removed.text


async def test_a_write_whose_state_holds_a_timestamp_still_audits(client):
    """Callers hand the audit log rows from the database and objects from the
    directory, and those carry datetimes. json.dumps refuses them, and it
    refused them from inside the audit write — after the change had already
    been made — so saving a group policy object made the change and answered
    500. Exercised through a real write because the failure is in the encoder,
    not in the SQL."""
    await sign_in(client)

    created = await client.post(
        "/api/v1/policy/gpos",
        json={"display_name": "Timestamped", "description": "has an updated_at"},
    )
    assert created.status_code == 201, created.text
    guid = created.json()["guid"]

    # PATCH audits the row it read back, updated_at and all.
    saved = await client.patch(
        "/api/v1/policy/gpo",
        json={
            "guid": guid,
            "settings": {
                "files": [{"path": "/etc/odm-audit-test", "content": "x\n", "mode": "0644"}]
            },
        },
    )
    assert saved.status_code == 200, saved.text

    entries = (await client.get("/api/v1/audit?limit=20")).json()["entries"]
    assert any(e["action"] == "gpo.update" for e in entries), [e["action"] for e in entries]


async def test_deleting_a_policy_object_puts_it_in_the_recycle_bin(client):
    """Deleting one snapshots the row it is about to remove, and that row
    carries an updated_at. json refused it, so the object vanished from the
    list, never reached the recycle bin, and the console showed a 500 — which
    is what an operator saw as "it says it does not exist"."""
    await sign_in(client)

    created = await client.post(
        "/api/v1/policy/gpos", json={"display_name": "Disposable", "description": ""}
    )
    assert created.status_code == 201, created.text
    guid = created.json()["guid"]

    removed = await client.delete(f"/api/v1/policy/gpo?guid={guid}")
    assert removed.status_code == 204, removed.text

    listed = (await client.get("/api/v1/recyclebin")).json()["items"]
    assert any(
        item["object_type"] == "gpo" and item["display_name"] == "Disposable"
        for item in listed
    ), listed
