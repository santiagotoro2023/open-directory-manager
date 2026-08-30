"""Phase 7: recycle-bin restore and the role framework."""

from __future__ import annotations

import pathlib

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
    for owned in ("objectGUID", "whenCreated", "memberOf", "distinguishedName"):
        assert owned not in entry, f"{owned} must not be written back"
    # The directory issues a fresh identifier; the snapshot's is not replayed.
    assert entry["objectSid"] != "S-1-5-21-1-2-3-9999"


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
    assert "--extra" not in command and "--wipe-everything" not in command
    assert command[:2] == ["--ha-role", "primary"]


def test_missing_required_argument_is_refused_before_anything_runs():
    # No role asks for one today — the test above enforces that — so this
    # holds the rule itself, for the next role that does.
    role = roles.Role(
        name="example",
        title="Example",
        summary="",
        arguments=(roles.Argument(name="needed", label="Needed"),),
    )
    with pytest.raises(roles.RoleError):
        roles.build_command(role, {})


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


def test_the_control_plane_never_runs_an_installer_itself():
    # Installers need root and a writable /usr; the API runs under
    # ProtectSystem=strict with NoNewPrivileges and must never grow a path
    # that tries anyway. Every install goes to the target machine's agent,
    # including when the target is the machine the console runs on.
    source = (pathlib.Path(__file__).parents[1] / "odm" / "roles.py").read_text()
    code = "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith("#")
    )
    for forbidden in ("import subprocess", "subprocess.run", "SUDO"):
        assert forbidden not in code, f"{forbidden} is back in roles.py"


def test_what_the_console_already_knows_is_not_asked_for():
    # An operator signed in to a domain should not be retyping its realm.
    known = {"realm": "CORP.EXAMPLE.INTERNAL", "domain": "corp.example.internal",
             "dc_host": "dc1.corp.example.internal"}
    filled = roles.derive(roles.get("dhcp"), {}, known)
    assert filled["realm"] == "CORP.EXAMPLE.INTERNAL"
    assert filled["dns_server"] == "dc1.corp.example.internal"
    # An explicit value still wins: a second server may use another controller.
    kept = roles.derive(roles.get("dhcp"), {"dns_server": "dc2.example.org"}, known)
    assert kept["dns_server"] == "dc2.example.org"


def test_installing_a_role_asks_for_nothing_but_the_server():
    # Every field the install dialog would draw is one the operator has to
    # answer before anything happens. None of them are answerable at that
    # point: the realm is derived, the storage directory has a default, and
    # what a service does belongs in the section that manages the service.
    for role in roles.REGISTRY.values():
        asked = [a.name for a in role.arguments if not a.configuration]
        assert asked == [], f"{role.name} still asks for {asked} at install time"


def test_every_registered_role_has_an_installer_script():
    # The agent runs deploy/install-<role>-role.sh. A descriptor without one
    # would fail on the target machine minutes after the operator clicked
    # Install, rather than here.
    deploy = pathlib.Path(__file__).resolve().parents[2] / "deploy"
    for role in roles.REGISTRY.values():
        if role.core:
            continue
        script = deploy / f"install-{role.name}-role.sh"
        assert script.exists(), f"{role.name} has no {script.name}"


def test_a_choice_argument_only_accepts_its_choices():
    with pytest.raises(roles.RoleError):
        roles.build_command(
            roles.get("dhcp"),
            {
                "ha_role": "whatever",
                "this_url": "http://dhcp1.corp.example.internal:8080/",
                "peer_url": "http://dhcp2.corp.example.internal:8080/",
                "realm": "CORP.EXAMPLE.INTERNAL",
                "dns_server": "10.10.0.10",
            },
        )


def test_every_argument_carries_a_label_the_console_can_show():
    """The console used to title-case the argument name, which produced field
    labels like "Ha role" and "This url"."""
    for role in roles.REGISTRY.values():
        for argument in role.arguments:
            assert argument.label and argument.label != argument.name, (
                f"{role.name}.{argument.name}"
            )
            assert argument.label[0].isupper(), f"{role.name}.{argument.name}"
            if argument.kind == "choice":
                assert argument.choices, f"{role.name}.{argument.name}"


def test_a_container_argument_accepts_a_distinguished_name():
    """The default pattern refuses commas and spaces, which every DN has."""
    command = roles.build_command(
        roles.get("pxe"),
        {
            "interface": "eth0",
            "domain": "corp.example.internal",
            "enrolment_token": "a" * 20,
            "ou": "OU=Workstations,DC=corp,DC=example,DC=internal",
        },
    )
    assert "OU=Workstations,DC=corp,DC=example,DC=internal" in command


def test_a_password_hash_argument_accepts_a_crypt_hash():
    command = roles.build_command(
        roles.get("pxe"),
        {
            "interface": "eth0",
            "domain": "corp.example.internal",
            "enrolment_token": "a" * 20,
            "local_password_hash": "$6$rounds=5000$abc123$Xy.Z/0abcdef",
        },
    )
    assert "--local-password-hash" in command


@pytest.mark.parametrize(
    "value",
    ["OU=x;rm -rf /", "OU=x\nDC=y", "OU=$(id)", "OU=`id`"],
)
def test_a_container_argument_still_refuses_a_shell_metacharacter(value):
    with pytest.raises(roles.RoleError):
        roles.build_command(
            roles.get("pxe"),
            {
                "interface": "eth0",
                "domain": "corp.example.internal",
                "enrolment_token": "a" * 20,
                "ou": value,
            },
        )


def test_boot_networks_are_passed_through_as_a_list():
    command = roles.build_command(
        roles.get("pxe"),
        {
            "interface": "eth0",
            "domain": "corp.example.internal",
            "enrolment_token": "a" * 20,
            "scopes": "10.10.0.0,10.20.0.0/24",
        },
    )
    assert "--scopes" in command
    assert "10.10.0.0,10.20.0.0/24" in command


@pytest.mark.parametrize("value", ["10.10.0.0; rm -rf /", "$(id)", "eth0", "10.10.0.0 10.20.0.0"])
def test_a_boot_network_that_is_not_a_network_is_refused(value):
    """The value ends up in a dnsmasq configuration file on a boot server."""
    with pytest.raises(roles.RoleError):
        roles.build_command(
            roles.get("pxe"),
            {
                "interface": "eth0",
                "domain": "corp.example.internal",
                "enrolment_token": "a" * 20,
                "scopes": value,
            },
        )


def test_every_role_has_an_installer_named_after_it():
    """The agent installs a role on another machine by running
    /usr/lib/odm/roles/install-<role>-role.sh. A script named anything else is
    one that can be installed here and nowhere else."""
    import pathlib

    deploy = pathlib.Path(__file__).resolve().parents[2] / "deploy"
    for role in roles.REGISTRY.values():
        if role.core:
            continue
        installer = deploy / f"install-{role.name}-role.sh"
        assert installer.exists(), f"{role.name} has no {installer.name}"


def test_every_task_the_api_queues_is_one_the_agent_runs():
    # The two lists are in different languages and neither imports the other,
    # so they drift silently: console-certificate was added to the API and the
    # agent and left out of KINDS, which made re-issuing the console's
    # certificate raise instead of queueing anything.
    import re

    root = pathlib.Path(__file__).resolve().parents[2]
    source = (root / "api" / "odm" / "tasks.py").read_text()
    block = source[source.index("KINDS = (") : source.index(")", source.index("KINDS = ("))]
    queued = set(re.findall(r'"([a-z-]+)"', block))

    handler = (root / "agent" / "internal" / "tasks" / "tasks.go").read_text()
    handled = set(re.findall(r'\tcase "([a-z-]+)":', handler))

    assert queued - handled == set(), "the API queues work no agent can run"
    assert handled - queued == set(), "the agent handles work nothing queues"


def test_every_installer_ships_what_it_sources():
    # The agent runs these out of /usr/lib/odm/roles, and a `.` of a file that
    # was never copied there fails on the target machine minutes after the
    # click, with a message about a missing file rather than about the role.
    deploy = pathlib.Path(__file__).resolve().parents[2] / "deploy"
    shipped = {path.name for path in deploy.glob("install-*-role.sh")}
    shipped.add("odm-role-common.sh")

    installer_copy = (deploy / "install-agent.sh").read_text()
    for script in sorted(deploy.glob("install-*-role.sh")):
        body = script.read_text()
        for line in body.splitlines():
            if not line.strip().startswith(". \"$(dirname"):
                continue
            sourced = line.rsplit("/", 1)[-1].strip('"')
            assert sourced in shipped, f"{script.name} sources unknown {sourced}"
            assert sourced in installer_copy, (
                f"{script.name} sources {sourced}, which install-agent.sh does not copy"
            )
