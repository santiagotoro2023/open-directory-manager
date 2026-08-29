"""Network access rules: what FreeRADIUS is told, and what is refused."""

from __future__ import annotations

import conftest  # noqa: F401  (environment setup ordering)
import pytest

from odm import radius


def policy(**overrides):
    base = {
        "name": "engineers-wifi",
        "group_dn": "CN=Engineers,DC=corp,DC=example,DC=internal",
        "group_name": "Engineers",
        "principal_kind": "user",
        "nas_identifiers": ["corp-wifi"],
        "access": "allow",
        "vlan": None,
        "ordering": 100,
        "enabled": True,
    }
    return {**base, **overrides}


def test_a_generated_secret_is_long_and_never_the_same_twice():
    first, second = radius.generate_secret(), radius.generate_secret()
    assert first != second
    assert len(first) >= 16


@pytest.mark.parametrize("secret", ["", "short", 'has"quote' + "x" * 10, "new\nline" + "x" * 10])
def test_a_weak_or_unquotable_secret_is_refused(secret):
    """It lands inside a quoted string in a configuration file."""
    with pytest.raises(radius.RadiusError):
        radius.validate_secret(secret)


def test_a_client_becomes_a_freeradius_client_block():
    body = radius.render_clients(
        [
            {
                "name": "core-switch",
                "address": "10.10.0.0/24",
                "secret": "a" * 24,
                "nas_identifier": "corp-wired",
            }
        ]
    )
    assert "client core-switch {" in body
    assert "ipaddr = 10.10.0.0/24" in body
    assert 'shortname = "corp-wired"' in body


@pytest.mark.parametrize("address", ["", "not-an-address", "10.10.0.1; rm -rf /", "$(id)"])
def test_a_client_address_that_is_not_one_is_refused(address):
    with pytest.raises(radius.RadiusError):
        radius.validate_address(address)


def test_a_deny_rule_is_evaluated_before_an_allow():
    """Deny wins over allow, as it does everywhere else in ODM."""
    body = radius.render_policies(
        [
            policy(name="allow-staff", ordering=1, access="allow"),
            policy(name="deny-contractors", ordering=99, access="deny", group_name="Contractors"),
        ]
    )
    assert body.index("deny-contractors") < body.index("allow-staff")


def test_a_disabled_rule_is_not_rendered_at_all():
    body = radius.render_policies([policy(name="off", enabled=False)])
    assert "off" not in body


def test_nothing_matching_is_a_refusal_rather_than_a_default():
    body = radius.render_policies([policy()])
    assert "reject" in body.rsplit("}", 2)[0]


def test_a_vlan_is_returned_to_the_device():
    body = radius.render_policies([policy(vlan=120)])
    assert "&Tunnel-Private-Group-Id := 120" in body
    assert "&Tunnel-Type := VLAN" in body


def test_a_computer_rule_matches_machine_names_and_a_user_rule_does_not():
    """A machine authenticates as host/<name> or NAME$, never as a person."""
    machines = radius.render_policies([policy(principal_kind="computer")])
    people = radius.render_policies([policy(principal_kind="user")])

    assert "host" in machines
    assert "!(&User-Name" in people


def test_a_rule_for_every_network_names_none():
    body = radius.render_policies([policy(nas_identifiers=[])])
    assert "NAS-Identifier" not in body


@pytest.mark.parametrize("name", ['corp"wifi', "corp\nwifi", "a" * 80, "$(id)"])
def test_a_network_name_that_could_break_the_configuration_is_refused(name):
    with pytest.raises(radius.RadiusError):
        radius.validate_nas_identifier(name)


def test_a_group_name_with_a_quote_cannot_break_out_of_the_condition():
    body = radius.render_policies([policy(group_name='Engineers" || "1')])
    assert '"1' not in body.replace('"%{Group-Name}"', "")
