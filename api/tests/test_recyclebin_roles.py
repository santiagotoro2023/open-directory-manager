"""Phase 7: recycle-bin restore and the role framework."""

from __future__ import annotations

import pytest
from conftest import BASE_DN, FakeLdap, sample_directory

from odm import objects, roles
from odm.config import get_settings

PARENT = f"OU=Example Corp,{BASE_DN}"
GROUP = f"CN=Helpdesk,{PARENT}"


def snapshot_of(dn: str, **overrides) -> dict:
    base = {
        "object_dn": dn,
        "parent_dn": PARENT,
        "attributes": {
            "objectClass": ["top", "person", "organizationalPerson", "user"],
            "cn": "grace",
            "sAMAccountName": "grace",
            "displayName": "Grace Hopper",
            "userAccountControl": 512,
            # Attributes the directory owns; writing them back would fail.
            "objectSid": "S-1-5-21-1-2-3-9999",
            "objectGUID": "{aaaa}",
            "whenCreated": "2026-01-01T00:00:00",
            "memberOf": [GROUP],
            "distinguishedName": dn,
            "objectType": "user",
        },
        "memberships": [GROUP],
        "members": [],
    }
    base.update(overrides)
    return base


@pytest.fixture
def ldap_only() -> FakeLdap:
    return FakeLdap(sample_directory())


# --------------------------------------------------------------- restore ---


def test_restore_recreates_the_object_without_directory_owned_attributes(ldap_only):
    dn = f"CN=grace,{PARENT}"
    restored = objects.restore(ldap_only, get_settings(), snapshot_of(dn))

    assert restored == dn
    entry = ldap_only.entries[dn]
    assert entry["sAMAccountName"] == "grace"
    assert entry["displayName"] == "Grace Hopper"
    for owned in ("objectSid", "objectGUID", "whenCreated", "memberOf", "distinguishedName"):
        assert owned not in entry, f"{owned} must not be written back"


def test_restored_account_comes_back_disabled(ldap_only):
    dn = f"CN=grace,{PARENT}"
    objects.restore(ldap_only, get_settings(), snapshot_of(dn))
    # It has no password, so an enabled account would be worse than an
    # obviously disabled one.
    assert int(ldap_only.entries[dn]["userAccountControl"]) & objects.UF_ACCOUNTDISABLE


def test_restore_rejoins_the_groups_it_belonged_to(ldap_only):
    dn = f"CN=grace,{PARENT}"
    objects.restore(ldap_only, get_settings(), snapshot_of(dn))
    assert ldap_only.entries[GROUP]["member"] == [dn]


def test_restoring_a_group_puts_its_members_back(ldap_only):
    dn = f"CN=Engineers,{PARENT}"
    member = f"CN=ada,{PARENT}"
    objects.restore(
        ldap_only,
        get_settings(),
        {
            "object_dn": dn,
            "parent_dn": PARENT,
            "attributes": {
                "objectClass": ["top", "group"],
                "cn": "Engineers",
                "sAMAccountName": "Engineers",
                "groupType": -2147483646,
            },
            "memberships": [],
            "members": [member],
        },
    )
    assert ldap_only.entries[dn]["member"] == [member]


def test_restore_refuses_when_the_object_is_back_already(ldap_only):
    with pytest.raises(objects.ObjectError):
        objects.restore(ldap_only, get_settings(), snapshot_of(f"CN=ada,{PARENT}"))


def test_restore_refuses_when_the_parent_container_is_gone(ldap_only):
    with pytest.raises(objects.NotFound):
        objects.restore(
            ldap_only,
            get_settings(),
            snapshot_of(f"CN=grace,OU=Gone,{BASE_DN}", parent_dn=f"OU=Gone,{BASE_DN}"),
        )


def test_restore_refuses_a_snapshot_with_no_object_class(ldap_only):
    broken = snapshot_of(f"CN=grace,{PARENT}")
    broken["attributes"].pop("objectClass")
    with pytest.raises(objects.ObjectError):
        objects.restore(ldap_only, get_settings(), broken)


# ----------------------------------------------------------------- roles ---


def test_core_role_is_never_installable():
    with pytest.raises(roles.RoleError):
        roles.build_command(roles.get("core"), {})


def test_unknown_roles_are_refused():
    with pytest.raises(roles.RoleError):
        roles.get("../../etc/passwd")
    for name in ("", "Dhcp", "dhcp;rm -rf /", "a" * 40):
        with pytest.raises(roles.RoleError):
            roles.validate_name(name)


def test_install_command_passes_only_declared_arguments():
    command = roles.build_command(
        roles.get("dhcp"),
        {
            "ha_role": "primary",
            "this_url": "http://dhcp1.corp.example.internal:8080/",
            "peer_url": "http://dhcp2.corp.example.internal:8080/",
            "realm": "CORP.EXAMPLE.INTERNAL",
            "dns_server": "10.10.0.10",
            "extra": "--wipe-everything",  # not declared, so never passed
        },
    )
    assert command[:4] == ["sudo", "-n", roles.ROLE_HELPER, "dhcp"]
    assert "--extra" not in command and "--wipe-everything" not in command
    assert command[4:6] == ["--ha-role", "primary"]


def test_missing_required_argument_is_refused_before_anything_runs():
    with pytest.raises(roles.RoleError):
        roles.build_command(roles.get("dhcp"), {"ha_role": "primary"})


def test_optional_argument_may_be_omitted():
    command = roles.build_command(
        roles.get("file-server"), {"share_name": "shared", "share_path": "/srv/shared"}
    )
    assert "--valid-group" not in command


@pytest.mark.parametrize(
    "value",
    ["primary; rm -rf /", "primary && reboot", "$(id)", "`id`", "with space", "a" * 300],
)
def test_hostile_argument_values_never_reach_the_installer(value):
    with pytest.raises(roles.RoleError):
        roles.build_command(
            roles.get("dhcp"),
            {
                "ha_role": value,
                "this_url": "http://a/",
                "peer_url": "http://b/",
                "realm": "CORP.EXAMPLE.INTERNAL",
                "dns_server": "10.10.0.10",
            },
        )


def test_every_registered_role_has_an_installer_case():
    # The privileged helper matches role names in a fixed case statement; a
    # descriptor without one would fail at install time rather than here.
    import pathlib

    helper = pathlib.Path(__file__).resolve().parents[2] / "deploy" / "odm-role-install"
    body = helper.read_text()
    for role in roles.REGISTRY.values():
        if role.core:
            continue
        assert f"{role.name})" in body, f"{role.name} has no case in odm-role-install"
