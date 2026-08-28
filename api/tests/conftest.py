"""Test configuration and doubles.

Settings are read from the environment at import time, so they are set here
before anything under odm/ is imported. Neither PostgreSQL nor a domain
controller is needed: the pool and the LDAP connection are faked.
"""

from __future__ import annotations

import os
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

os.environ.update(
    {
        "ODM_REALM": "corp.example.internal",
        "ODM_DOMAIN": "corp.example.internal",
        "ODM_LDAP_URI": "ldaps://dc1.corp.example.internal",
        "ODM_LDAP_CA_CERT": "/nonexistent/ca.pem",
        "ODM_DATABASE_URL": "postgresql://odm@localhost/odm",
        "ODM_ALLOWED_ORIGINS": '["https://odm.corp.example.internal"]',
    }
)

import httpx  # noqa: E402
import pytest  # noqa: E402
from ldap3 import MODIFY_ADD, MODIFY_DELETE  # noqa: E402

from odm import directory  # noqa: E402
from odm.main import create_app  # noqa: E402

BASE_DN = "DC=corp,DC=example,DC=internal"

ADMIN = directory.DirectoryUser(
    dn=f"CN=ada,OU=Example Corp,{BASE_DN}",
    sam_account_name="ada",
    user_principal_name="ada@CORP.EXAMPLE.INTERNAL",
    display_name="Ada Admin",
    sid="S-1-5-21-1-2-3-1104",
    group_sids=("S-1-5-21-1-2-3-512",),
    group_dns=(f"CN=Domain Admins,CN=Users,{BASE_DN}",),
    is_domain_admin=True,
)

# A delegated administrator: no admin-group membership, so everything they
# can do comes from an rbac_assignment.
DELEGATE = directory.DirectoryUser(
    dn=f"CN=hank,OU=Example Corp,{BASE_DN}",
    sam_account_name="hank",
    user_principal_name="hank@CORP.EXAMPLE.INTERNAL",
    display_name="Hank Helpdesk",
    sid="S-1-5-21-1-2-3-2201",
    group_sids=("S-1-5-21-1-2-3-1601",),
    group_dns=(f"CN=Helpdesk,OU=Example Corp,{BASE_DN}",),
    is_domain_admin=False,
)


# ------------------------------------------------------------ fake database ---


class FakeConn:
    def __init__(self, state: dict):
        self.state = state

    async def execute(self, sql, *args):
        self.state.setdefault("executed", []).append((sql, args))
        if "revoked_at = now()" in sql:
            self.state["session"] = None

    async def fetch(self, sql, *args):
        self.state.setdefault("executed", []).append((sql, args))
        if "FROM rbac_assignment" in sql:
            return self.state.get("grants", [])
        return self.state.get("rows", [])

    async def fetchval(self, sql, *args):
        if "count(*)" in sql:
            return self.state.get("failures", 0)
        if "admin_verified_at <" in sql:
            return self.state.get("admin_stale", False)
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
                "is_domain_admin": args[9],
                "group_sids": list(args[10]),
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

    async def fetch(self, sql, *args):
        return await FakeConn(self.state).fetch(sql, *args)

    async def fetchval(self, sql, *args):
        return await FakeConn(self.state).fetchval(sql, *args)

    async def fetchrow(self, sql, *args):
        return await FakeConn(self.state).fetchrow(sql, *args)

    async def execute(self, sql, *args):
        return await FakeConn(self.state).execute(sql, *args)


def audit_rows(state: dict) -> list[dict]:
    """Audit inserts recorded by the fake pool, oldest first."""
    return [
        {
            "actor": args[0],
            "action": args[3],
            "object_type": args[4],
            "object_dn": args[5],
            "outcome": args[6],
            "detail": args[7],
            "before": args[8],
            "after": args[9],
        }
        for sql, args in state.get("executed", [])
        if "INSERT INTO audit_log" in sql
    ]


def recycle_bin_rows(state: dict) -> list[tuple]:
    return [args for sql, args in state.get("executed", []) if "INSERT INTO deleted_object" in sql]


# --------------------------------------------------------------- fake LDAP ---


class FakeLdap:
    """Enough of an ldap3 Connection to exercise the object layer.

    Filters are matched crudely (objectClass/objectCategory substrings) —
    filter *construction* is covered by its own unit tests; this double
    exists to prove the CRUD, guard and audit paths.
    """

    def __init__(self, entries: dict[str, dict]):
        self.entries = entries
        self.result = {"result": 0, "description": "success"}
        self.response: list[dict] = []
        self.unbound = False

    # -- helpers --
    def _in_scope(self, dn: str, base: str, scope: str) -> bool:
        dn, base = dn.lower(), base.lower()
        if scope == "BASE":
            return dn == base
        if dn == base:
            return False
        if not dn.endswith("," + base):
            return False
        if scope == "LEVEL":
            return "," not in dn[: -(len(base) + 1)]
        return True

    def _matches(self, entry: dict, ldap_filter: str) -> bool:
        classes = {c.lower() for c in entry.get("objectClass", [])}
        tokens = [t.lstrip("|&!") for t in ldap_filter.replace("(", "").split(")")]
        wanted = {
            token.split("=", 1)[1].lower()
            for token in tokens
            if token.lower().startswith(("objectclass=", "objectcategory="))
        }
        wanted.discard("*")
        if not wanted:
            return True
        if "person" in wanted:
            wanted.discard("person")
            wanted.add("user")
        return bool(wanted & classes)

    # -- ldap3 surface --
    def search(self, search_base, search_filter, search_scope, attributes, paged_size=None):
        self.result = {"result": 0, "description": "success"}
        self.response = [
            {"type": "searchResEntry", "dn": dn, "attributes": dict(attrs)}
            for dn, attrs in self.entries.items()
            if self._in_scope(dn, search_base, str(search_scope))
            and self._matches(attrs, search_filter)
        ]
        return True

    def add(self, dn, object_classes, attributes):
        if dn in self.entries:
            self.result = {"result": 68, "description": "entryAlreadyExists", "message": ""}
            return False
        self.entries[dn] = {"objectClass": list(object_classes), **attributes}
        self.result = {"result": 0, "description": "success"}
        return True

    def modify(self, dn, changes):
        entry = self.entries[dn]
        for attribute, operations in changes.items():
            for operation, values in operations:
                current = entry.get(attribute, [])
                current = current if isinstance(current, list) else [current]
                if operation == MODIFY_ADD:
                    entry[attribute] = current + [v for v in values if v not in current]
                elif operation == MODIFY_DELETE:
                    remaining = [v for v in current if v not in values]
                    if remaining:
                        entry[attribute] = remaining
                    else:
                        entry.pop(attribute, None)
                elif values:
                    entry[attribute] = values[0] if len(values) == 1 else list(values)
                else:
                    entry.pop(attribute, None)
        self.result = {"result": 0, "description": "success"}
        return True

    def delete(self, dn):
        self.entries.pop(dn, None)
        self.result = {"result": 0, "description": "success"}
        return True

    def modify_dn(self, dn, relative_dn, new_superior=None):
        entry = self.entries.pop(dn)
        self.entries[f"{relative_dn},{new_superior}"] = entry
        self.result = {"result": 0, "description": "success"}
        return True

    def unbind(self):
        self.unbound = True


def sample_directory() -> dict[str, dict]:
    return {
        BASE_DN: {"objectClass": ["top", "domainDNS"], "name": "corp"},
        f"CN=Users,{BASE_DN}": {"objectClass": ["top", "container"], "cn": "Users"},
        f"CN=Builtin,{BASE_DN}": {"objectClass": ["top", "builtinDomain"], "cn": "Builtin"},
        f"CN=Administrators,CN=Builtin,{BASE_DN}": {
            "objectClass": ["top", "group"],
            "cn": "Administrators",
            "sAMAccountName": "Administrators",
        },
        f"OU=Example Corp,{BASE_DN}": {
            "objectClass": ["top", "organizationalUnit"],
            "ou": "Example Corp",
        },
        f"CN=ada,OU=Example Corp,{BASE_DN}": {
            "objectClass": ["top", "person", "organizationalPerson", "user"],
            "cn": "ada",
            "sAMAccountName": "ada",
            "displayName": "Ada Admin",
            "userAccountControl": 512,
        },
        f"CN=Helpdesk,OU=Example Corp,{BASE_DN}": {
            "objectClass": ["top", "group"],
            "cn": "Helpdesk",
            "sAMAccountName": "Helpdesk",
            "groupType": -2147483646,
        },
        f"CN=Domain Admins,CN=Users,{BASE_DN}": {
            "objectClass": ["top", "group"],
            "cn": "Domain Admins",
            "sAMAccountName": "Domain Admins",
            "groupType": -2147483646,
        },
    }


# ---------------------------------------------------------------- fixtures ---


@pytest.fixture
def state() -> dict:
    return {}


@pytest.fixture
def ldap(monkeypatch) -> FakeLdap:
    fake = FakeLdap(sample_directory())
    monkeypatch.setattr(directory, "service_connection", lambda settings, read_only=True: fake)
    return fake


@pytest.fixture
def client(state, monkeypatch) -> httpx.AsyncClient:
    app = create_app()
    app.state.pool = FakePool(state)
    http = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),  # no lifespan: no real database
        base_url="https://odm.test",
    )
    http.state = state  # type: ignore[attr-defined]
    http.monkeypatch = monkeypatch  # type: ignore[attr-defined]
    return http


async def _sign_in(client, user: directory.DirectoryUser) -> httpx.AsyncClient:
    client.monkeypatch.setattr(
        directory, "authenticate", lambda settings, username, password: user
    )
    response = await client.post(
        "/api/v1/auth/login",
        json={"username": user.sam_account_name, "password": "pw"},
    )
    assert response.status_code == 200, response.text
    client.headers["X-ODM-CSRF"] = response.json()["csrf_token"]
    return client


@pytest.fixture
async def admin_client(client) -> httpx.AsyncClient:
    """A client signed in as a member of the admin group."""
    return await _sign_in(client, ADMIN)


def grant(role: str, scope_dn: str, permissions: list[str], sid: str) -> dict:
    """One row shaped like the delegation query returns."""
    return {
        "role_name": role,
        "scope_dn": scope_dn,
        "permissions": permissions,
        "principal_sid": sid,
    }
