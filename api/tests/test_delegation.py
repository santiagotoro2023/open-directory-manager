"""Phase 8: delegated administration.

A domain admin can do everything. Everyone else can do exactly what an
assignment grants, exactly where it grants it.
"""

from __future__ import annotations

import pytest
from conftest import ADMIN, BASE_DN, DELEGATE, _sign_in

from odm import authz, directory

HELPDESK_OU = f"OU=Helpdesk,OU=Example Corp,{BASE_DN}"
OTHER_OU = f"OU=Finance,{BASE_DN}"


def grant(permissions: list[str], scope: str = HELPDESK_OU) -> authz.Grant:
    return authz.Grant(role_name="helpdesk", scope_dn=scope, permissions=frozenset(permissions))


# ------------------------------------------------------------ scope maths ---


def test_a_scope_covers_itself_and_everything_beneath_it():
    grants = [grant(["user.write"])]
    for dn in (HELPDESK_OU, f"CN=ada,{HELPDESK_OU}", f"CN=bo,OU=Team,{HELPDESK_OU}"):
        assert authz.permits(grants, "user.write", dn, BASE_DN, domain_admin=False)


def test_a_scope_does_not_reach_outside_itself():
    grants = [grant(["user.write"])]
    for dn in (BASE_DN, OTHER_OU, f"CN=ada,{OTHER_OU}", f"OU=Example Corp,{BASE_DN}"):
        assert not authz.permits(grants, "user.write", dn, BASE_DN, domain_admin=False)


def test_a_similar_looking_sibling_is_not_covered():
    # "OU=Helpdesk2,…" must not match a scope of "OU=Helpdesk,…".
    grants = [grant(["user.write"])]
    sibling = f"CN=ada,OU=Helpdesk2,OU=Example Corp,{BASE_DN}"
    assert not authz.permits(grants, "user.write", sibling, BASE_DN, domain_admin=False)


def test_permissions_are_not_transitive_between_actions():
    grants = [grant(["user.write"])]
    assert not authz.permits(grants, "object.delete", HELPDESK_OU, BASE_DN, domain_admin=False)


def test_wildcard_covers_every_permission():
    grants = [grant(["*"], scope=BASE_DN)]
    assert authz.permits(grants, "dhcp.write", None, BASE_DN, domain_admin=False)


def test_domain_wide_actions_need_an_assignment_at_the_domain_head():
    assert not authz.permits([grant(["dns.write"])], "dns.write", None, BASE_DN, domain_admin=False)
    assert authz.permits(
        [grant(["dns.write"], scope=BASE_DN)], "dns.write", None, BASE_DN, domain_admin=False
    )


def test_domain_admin_bypasses_every_check():
    assert authz.permits([], "anything.at.all", OTHER_OU, BASE_DN, domain_admin=True)


def test_describe_reports_reach_for_the_console():
    assert authz.describe([], domain_admin=True)["permissions"] == ["*"]
    described = authz.describe([grant(["user.write", "directory.read"])], domain_admin=False)
    assert described["permissions"] == ["directory.read", "user.write"]
    assert described["scopes"] == [{"role": "helpdesk", "scope_dn": HELPDESK_OU}]


# ---------------------------------------------------------------- the gate ---


async def test_an_account_with_nothing_delegated_cannot_sign_in(client):
    client.monkeypatch.setattr(
        directory, "authenticate", lambda settings, username, password: DELEGATE
    )
    response = await client.post(
        "/api/v1/auth/login", json={"username": "hank", "password": "pw"}
    )
    assert response.status_code == 403
    assert "delegated" in response.json()["detail"]


async def test_a_delegate_signs_in_and_is_told_what_they_hold(client):
    client.state["grants"] = [
        {
            "role_name": "helpdesk",
            "scope_dn": HELPDESK_OU,
            "permissions": ["directory.read", "user.write"],
        }
    ]
    await _sign_in(client, DELEGATE)

    session = (await client.get("/api/v1/auth/session")).json()
    assert session["domain_admin"] is False
    assert session["permissions"] == ["directory.read", "user.write"]
    assert session["scopes"] == [{"role": "helpdesk", "scope_dn": HELPDESK_OU}]


async def test_a_domain_admin_is_reported_as_unrestricted(admin_client):
    session = (await admin_client.get("/api/v1/auth/session")).json()
    assert session["domain_admin"] is True and session["permissions"] == ["*"]


# --------------------------------------------------------------- in anger ---


@pytest.fixture
async def helpdesk_client(client, ldap):
    client.state["grants"] = [
        {
            "role_name": "helpdesk",
            "scope_dn": f"OU=Example Corp,{BASE_DN}",
            "permissions": ["directory.read", "user.write", "user.password.reset"],
        }
    ]
    return await _sign_in(client, DELEGATE)


async def test_a_delegate_may_act_inside_their_scope(helpdesk_client, ldap):
    response = await helpdesk_client.post(
        "/api/v1/directory/users",
        json={
            "container": f"OU=Example Corp,{BASE_DN}",
            "sam_account_name": "grace",
        },
    )
    assert response.status_code == 201


async def test_a_delegate_may_not_act_outside_their_scope(helpdesk_client, ldap):
    response = await helpdesk_client.post(
        "/api/v1/directory/users",
        json={"container": BASE_DN, "sam_account_name": "mallory"},
    )
    assert response.status_code == 403
    assert "user.write" in response.json()["detail"]


async def test_a_delegate_holds_only_the_permissions_granted(helpdesk_client, ldap):
    # The helpdesk grant above carries no object.delete.
    response = await helpdesk_client.delete(
        "/api/v1/directory/object",
        params={"dn": f"CN=ada,OU=Example Corp,{BASE_DN}"},
    )
    assert response.status_code == 403
    assert "object.delete" in response.json()["detail"]


async def test_a_delegate_cannot_manage_delegation(helpdesk_client):
    response = await helpdesk_client.get("/api/v1/rbac/roles")
    assert response.status_code == 403
    assert "domain administrators" in response.json()["detail"]


async def test_a_delegate_cannot_reach_another_subsystem(helpdesk_client):
    for path in ("/api/v1/policy/gpos", "/api/v1/dns/zones", "/api/v1/dhcp/scopes"):
        assert (await helpdesk_client.get(path)).status_code == 403


async def test_a_domain_admin_can_manage_delegation(admin_client):
    assert (await admin_client.get("/api/v1/rbac/permissions")).status_code == 200
    assert (await admin_client.get("/api/v1/rbac/roles")).status_code == 200


async def test_losing_every_assignment_revokes_a_delegates_session(client, ldap):
    client.state["grants"] = [
        {"role_name": "helpdesk", "scope_dn": HELPDESK_OU, "permissions": ["directory.read"]}
    ]
    await _sign_in(client, DELEGATE)

    client.state["admin_stale"] = True
    client.state["grants"] = []
    client.monkeypatch.setattr(
        directory, "authorize_principal", lambda settings, upn: DELEGATE
    )

    assert (await client.get("/api/v1/directory/tree")).status_code == 403
    assert (await client.get("/api/v1/auth/session")).status_code == 401


async def test_admin_session_survives_the_recheck(admin_client, ldap):
    admin_client.state["admin_stale"] = True
    admin_client.monkeypatch.setattr(
        directory, "authorize_principal", lambda settings, upn: ADMIN
    )
    assert (await admin_client.get("/api/v1/directory/tree")).status_code == 200
