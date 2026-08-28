"""Phase 2: directory CRUD, the protected-object guard, and audit wiring."""

from __future__ import annotations

import pytest
from conftest import BASE_DN, audit_rows, recycle_bin_rows

from odm import objects
from odm.config import get_settings
from odm.objects import NotFound, ProtectedObject, normalize_dn, parent_dn, rdn_value

# --------------------------------------------------------------- pure bits ---


def test_normalize_dn_requires_the_domain_head():
    settings = get_settings()
    assert normalize_dn(settings, f"CN=ada,{BASE_DN}") == f"CN=ada,{BASE_DN}"
    for outside in ("CN=ada,DC=evil,DC=example", "", "not a dn", "CN=x," + "a" * 2000):
        with pytest.raises(NotFound):
            normalize_dn(settings, outside)


def test_dn_helpers():
    assert parent_dn(f"CN=ada,OU=Example Corp,{BASE_DN}") == f"OU=Example Corp,{BASE_DN}"
    assert rdn_value("CN=Ada Lovelace,DC=x") == "Ada Lovelace"


@pytest.mark.parametrize(
    "dn",
    [
        BASE_DN,
        f"CN=Users,{BASE_DN}",
        f"OU=Domain Controllers,{BASE_DN}",
        f"CN=Administrators,CN=Builtin,{BASE_DN}",
        f"CN=Domain Admins,CN=Users,{BASE_DN}",
    ],
)
def test_protected_objects_are_refused(dn):
    with pytest.raises(ProtectedObject):
        objects.assert_mutable(get_settings(), dn)


def test_ordinary_objects_are_mutable():
    objects.assert_mutable(get_settings(), f"CN=ada,OU=Example Corp,{BASE_DN}")


def test_group_type_scopes_are_the_real_ad_values():
    assert objects.GROUP_TYPES["global-security"] == -2147483646
    assert objects.GROUP_TYPES["domain-local-security"] == -2147483644
    assert objects.GROUP_TYPES["universal-distribution"] == 8


# ------------------------------------------------------------------- reads ---


async def test_tree_lists_containers(admin_client, ldap):
    r = await admin_client.get("/api/v1/directory/tree")
    assert r.status_code == 200
    body = r.json()
    assert body["base_dn"] == BASE_DN
    dns = {node["distinguishedName"] for node in body["nodes"]}
    assert f"OU=Example Corp,{BASE_DN}" in dns
    assert f"CN=Users,{BASE_DN}" in dns


async def test_list_objects_in_a_container(admin_client, ldap):
    r = await admin_client.get(
        "/api/v1/directory/objects",
        params={"container": f"OU=Example Corp,{BASE_DN}", "object_type": "user"},
    )
    assert r.status_code == 200
    names = [o["sAMAccountName"] for o in r.json()["objects"]]
    assert names == ["ada"]


async def test_reading_outside_the_domain_is_404(admin_client, ldap):
    r = await admin_client.get(
        "/api/v1/directory/object", params={"dn": "CN=ada,DC=evil,DC=example"}
    )
    assert r.status_code == 404


# ----------------------------------------------------------------- creates ---


async def test_create_user_sets_password_and_is_audited(admin_client, ldap):
    r = await admin_client.post(
        "/api/v1/directory/users",
        json={
            "container": f"OU=Example Corp,{BASE_DN}",
            "sam_account_name": "grace",
            "name": "Grace Hopper",
            "given_name": "Grace",
            "surname": "Hopper",
            "password": "Correct-Horse-1",
            "must_change_password": True,
        },
    )
    assert r.status_code == 201
    dn = f"CN=Grace Hopper,OU=Example Corp,{BASE_DN}"
    assert dn in ldap.entries

    entry = ldap.entries[dn]
    assert entry["sAMAccountName"] == "grace"
    assert entry["userPrincipalName"] == "grace@corp.example.internal"
    assert entry["unicodePwd"] == '"Correct-Horse-1"'.encode("utf-16-le")
    assert entry["pwdLastSet"] == 0
    assert int(entry["userAccountControl"]) & objects.UF_ACCOUNTDISABLE == 0

    logged = audit_rows(admin_client.state)[-1]
    assert (logged["action"], logged["outcome"], logged["object_dn"]) == (
        "user.create",
        "success",
        dn,
    )
    assert "Correct-Horse-1" not in str(logged)


async def test_user_without_a_password_stays_disabled(admin_client, ldap):
    await admin_client.post(
        "/api/v1/directory/users",
        json={"container": f"OU=Example Corp,{BASE_DN}", "sam_account_name": "linus"},
    )
    entry = ldap.entries[f"CN=linus,OU=Example Corp,{BASE_DN}"]
    assert int(entry["userAccountControl"]) & objects.UF_ACCOUNTDISABLE


async def test_create_group_and_ou(admin_client, ldap):
    ou = await admin_client.post(
        "/api/v1/directory/ous",
        json={"container": BASE_DN, "name": "Engineering", "description": "Builds things"},
    )
    assert ou.status_code == 201

    group = await admin_client.post(
        "/api/v1/directory/groups",
        json={
            "container": f"OU=Engineering,{BASE_DN}",
            "name": "Engineers",
            "group_type": "domain-local-security",
        },
    )
    assert group.status_code == 201
    assert ldap.entries[f"CN=Engineers,OU=Engineering,{BASE_DN}"]["groupType"] == -2147483644


async def test_create_computer_appends_the_dollar(admin_client, ldap):
    await admin_client.post(
        "/api/v1/directory/computers",
        json={"container": f"OU=Example Corp,{BASE_DN}", "name": "ws01"},
    )
    assert ldap.entries[f"CN=ws01,OU=Example Corp,{BASE_DN}"]["sAMAccountName"] == "ws01$"


async def test_bulk_create_reports_each_row(admin_client, ldap):
    r = await admin_client.post(
        "/api/v1/directory/users/bulk",
        json={
            "users": [
                {"container": f"OU=Example Corp,{BASE_DN}", "sam_account_name": "alan"},
                {"container": "OU=Nowhere,DC=evil,DC=example", "sam_account_name": "mallory"},
                {"container": f"OU=Example Corp,{BASE_DN}", "sam_account_name": "edsger"},
            ]
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["created"] == 2
    assert [row["created"] for row in body["results"]] == [True, False, True]
    assert f"CN=edsger,OU=Example Corp,{BASE_DN}" in ldap.entries


# ----------------------------------------------------------------- updates ---


async def test_update_allowed_attribute(admin_client, ldap):
    dn = f"CN=ada,OU=Example Corp,{BASE_DN}"
    r = await admin_client.patch(
        "/api/v1/directory/object", json={"dn": dn, "changes": {"title": "Chief Engineer"}}
    )
    assert r.status_code == 200
    assert ldap.entries[dn]["title"] == "Chief Engineer"

    logged = audit_rows(admin_client.state)[-1]
    assert logged["action"] == "object.update"
    assert "Chief Engineer" in logged["after"]


async def test_update_rejects_attributes_outside_the_allow_list(admin_client, ldap):
    r = await admin_client.patch(
        "/api/v1/directory/object",
        json={
            "dn": f"CN=ada,OU=Example Corp,{BASE_DN}",
            "changes": {"userAccountControl": "512", "memberOf": "CN=Domain Admins"},
        },
    )
    assert r.status_code == 400
    assert "not editable" in r.json()["detail"]
    assert audit_rows(admin_client.state)[-1]["outcome"] == "denied"


async def test_move_between_ous(admin_client, ldap):
    await admin_client.post(
        "/api/v1/directory/ous", json={"container": BASE_DN, "name": "Retired"}
    )
    r = await admin_client.post(
        "/api/v1/directory/object/move",
        json={
            "dn": f"CN=ada,OU=Example Corp,{BASE_DN}",
            "target_container": f"OU=Retired,{BASE_DN}",
        },
    )
    assert r.status_code == 200
    assert f"CN=ada,OU=Retired,{BASE_DN}" in ldap.entries
    assert audit_rows(admin_client.state)[-1]["action"] == "object.move"


async def test_move_into_itself_is_refused(admin_client, ldap):
    r = await admin_client.post(
        "/api/v1/directory/object/move",
        json={
            "dn": f"OU=Example Corp,{BASE_DN}",
            "target_container": f"OU=Example Corp,{BASE_DN}",
        },
    )
    assert r.status_code == 400


async def test_disable_and_enable(admin_client, ldap):
    dn = f"CN=ada,OU=Example Corp,{BASE_DN}"
    await admin_client.post("/api/v1/directory/object/enabled", json={"dn": dn, "enabled": False})
    assert int(ldap.entries[dn]["userAccountControl"]) & objects.UF_ACCOUNTDISABLE
    await admin_client.post("/api/v1/directory/object/enabled", json={"dn": dn, "enabled": True})
    assert not int(ldap.entries[dn]["userAccountControl"]) & objects.UF_ACCOUNTDISABLE


async def test_password_reset_is_audited_without_the_password(admin_client, ldap):
    dn = f"CN=ada,OU=Example Corp,{BASE_DN}"
    r = await admin_client.post(
        "/api/v1/directory/user/password", json={"dn": dn, "password": "S3cret-Value"}
    )
    assert r.status_code == 204
    logged = audit_rows(admin_client.state)[-1]
    assert logged["action"] == "user.password.reset"
    assert "S3cret-Value" not in str(logged)


async def test_group_membership_edit_is_idempotent(admin_client, ldap):
    group = f"CN=Helpdesk,OU=Example Corp,{BASE_DN}"
    member = f"CN=ada,OU=Example Corp,{BASE_DN}"

    await admin_client.post("/api/v1/directory/group/members", json={"dn": group, "add": [member]})
    assert ldap.entries[group]["member"] == [member]

    # Adding twice must not error or duplicate.
    await admin_client.post("/api/v1/directory/group/members", json={"dn": group, "add": [member]})
    assert ldap.entries[group]["member"] == [member]

    await admin_client.post(
        "/api/v1/directory/group/members", json={"dn": group, "remove": [member]}
    )
    assert "member" not in ldap.entries[group]


# ----------------------------------------------------------------- deletes ---


async def test_delete_snapshots_into_the_recycle_bin(admin_client, ldap):
    dn = f"CN=Helpdesk,OU=Example Corp,{BASE_DN}"
    r = await admin_client.delete("/api/v1/directory/object", params={"dn": dn})
    assert r.status_code == 204
    assert dn not in ldap.entries

    snapshots = recycle_bin_rows(admin_client.state)
    assert len(snapshots) == 1
    assert snapshots[0][0] == dn and snapshots[0][1] == "group"
    assert audit_rows(admin_client.state)[-1]["action"] == "object.delete"


async def test_deleting_a_protected_group_is_refused_and_audited(admin_client, ldap):
    dn = f"CN=Domain Admins,CN=Users,{BASE_DN}"
    r = await admin_client.delete("/api/v1/directory/object", params={"dn": dn})
    assert r.status_code == 409
    assert dn in ldap.entries
    assert not recycle_bin_rows(admin_client.state)

    logged = audit_rows(admin_client.state)[-1]
    assert (logged["action"], logged["outcome"]) == ("object.delete", "denied")


async def test_deleting_a_non_empty_container_is_refused(admin_client, ldap):
    r = await admin_client.delete(
        "/api/v1/directory/object", params={"dn": f"OU=Example Corp,{BASE_DN}"}
    )
    assert r.status_code == 400
    assert f"OU=Example Corp,{BASE_DN}" in ldap.entries


async def test_writes_require_a_session(client, ldap):
    r = await client.post(
        "/api/v1/directory/ous", json={"container": BASE_DN, "name": "Nope"}
    )
    assert r.status_code == 401
