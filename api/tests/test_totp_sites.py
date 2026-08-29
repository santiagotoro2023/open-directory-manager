"""The second factor, sites, and per-entry targeting."""

from __future__ import annotations

import time

import conftest  # noqa: F401  (environment setup ordering)
import pytest

from odm import password_policy, policy, sites, totp

# --------------------------------------------------------------------- totp --


def code_at(secret: str, when: float) -> str:
    return totp._code_for(secret, int(when // totp.PERIOD))


def test_a_code_from_the_device_is_accepted():
    secret = totp.generate_secret()
    now = time.time()
    assert totp.verify(secret, code_at(secret, now), now=now)


def test_a_code_cannot_be_used_twice():
    """It stays valid for thirty seconds; without remembering the last step,
    anyone who saw it could use it again inside that window."""
    secret = totp.generate_secret()
    now = time.time()
    step = totp.verify(secret, code_at(secret, now), now=now)

    with pytest.raises(totp.TotpError):
        totp.verify(secret, code_at(secret, now), last_step=step, now=now)


def test_a_clock_slightly_out_still_works():
    secret = totp.generate_secret()
    now = time.time()
    # One step behind, which a phone drifting by a few seconds produces.
    assert totp.verify(secret, code_at(secret, now - totp.PERIOD), now=now)


def test_a_clock_far_out_does_not():
    secret = totp.generate_secret()
    now = time.time()
    with pytest.raises(totp.TotpError):
        totp.verify(secret, code_at(secret, now - 10 * totp.PERIOD), now=now)


@pytest.mark.parametrize("code", ["", "12345", "1234567", "abcdef", "12 34 56 78"])
def test_anything_that_is_not_six_digits_is_refused(code):
    with pytest.raises(totp.TotpError):
        totp.verify(totp.generate_secret(), code)


def test_a_code_from_another_secret_is_refused():
    now = time.time()
    with pytest.raises(totp.TotpError):
        totp.verify(totp.generate_secret(), code_at(totp.generate_secret(), now), now=now)


def test_the_provisioning_uri_is_what_an_authenticator_expects():
    secret = totp.generate_secret()
    uri = totp.provisioning_uri(secret, "ada@corp.example.internal", "corp.example.internal")

    assert uri.startswith("otpauth://totp/")
    assert f"secret={secret}" in uri
    assert "digits=6" in uri and "period=30" in uri


def test_recovery_codes_are_unique_and_single_use():
    codes = totp.generate_recovery_codes()
    assert len(codes) == len(set(codes)) == totp.RECOVERY_CODES
    assert totp.matches_recovery(codes, codes[3]) == codes[3]
    assert totp.matches_recovery(codes, "nope") is None


# -------------------------------------------------------------------- sites --


def test_a_machine_is_placed_by_its_address():
    subnets = {"10.10.0.0/16": "Head office", "10.20.0.0/24": "Branch"}
    assert sites.site_for(["10.20.0.5"], subnets) == "Branch"
    assert sites.site_for(["10.10.5.5"], subnets) == "Head office"


def test_the_more_specific_subnet_wins():
    """A /24 inside a /16 is the deliberate statement, so it decides."""
    subnets = {"10.10.0.0/16": "Head office", "10.10.7.0/24": "Third floor"}
    assert sites.site_for(["10.10.7.9"], subnets) == "Third floor"


def test_a_machine_on_two_networks_lands_where_the_more_precise_one_says():
    subnets = {"10.99.0.0/24": "VPN", "10.10.0.0/8": "Everything"}
    assert sites.site_for(["10.10.0.4", "10.99.0.2"], subnets) == "VPN"


def test_an_address_in_no_subnet_is_unplaced():
    assert sites.site_for(["192.0.2.7"], {"10.10.0.0/16": "Head office"}) is None


def test_a_machine_with_no_usable_address_is_unplaced():
    assert sites.site_for(["not-an-address", ""], {"10.10.0.0/16": "x"}) is None


def test_overlap_is_reported_rather_than_refused():
    """A /16 and a /24 inside it is the normal way to say 'except that floor'."""
    found = sites.overlapping("10.10.7.0/24", ["10.10.0.0/16", "192.168.0.0/24"])
    assert found == ["10.10.0.0/16"]


@pytest.mark.parametrize("cidr", ["", "10.10.0.0", "not/a/network", "10.10.0.0/33"])
def test_a_subnet_that_is_not_one_is_refused(cidr):
    with pytest.raises(sites.SiteError):
        sites.validate_subnet(cidr)


# --------------------------------------------------------- password policies --


def test_reconcile_says_what_to_add_and_what_to_remove():
    change = password_policy.reconcile(
        "engineers",
        wanted=["CN=a,DC=x", "CN=b,DC=x"],
        current=["CN=b,DC=x", "CN=c,DC=x"],
    )
    assert change["add"] == ["CN=a,DC=x"]
    assert change["remove"] == ["CN=c,DC=x"]


def test_reconcile_does_nothing_when_they_already_agree():
    change = password_policy.reconcile("x", ["CN=a,DC=x"], ["CN=a,DC=x"])
    assert change == {"add": [], "remove": []}


# ------------------------------------------------------- per-entry targeting --


def target(**overrides):
    base = {
        "dn": "CN=ws-014,DC=corp",
        "hostname": "ws-014",
        "os_id": "debian-13",
        "group_dns": ("CN=Laptops,DC=corp",),
        "ip_addresses": ("10.20.0.5",),
    }
    return policy.Target(**{**base, **overrides})


def gpo_with(items):
    return policy.Gpo(
        guid="g1",
        display_name="drives",
        enabled=True,
        settings={"drive_maps": items},
    )


def test_an_entry_whose_targeting_does_not_match_is_left_out():
    merged = policy.merge_settings(
        [
            gpo_with(
                [
                    {"name": "laptops", "mount_point": "/mnt/a",
                     "targeting": {"security_groups": ["CN=Laptops,DC=corp"]}},
                    {"name": "desks", "mount_point": "/mnt/b",
                     "targeting": {"security_groups": ["CN=Desks,DC=corp"]}},
                ]
            )
        ],
        target(),
    )
    names = [entry["name"] for entry in merged["drive_maps"]]
    assert names == ["laptops"]


def test_an_entry_with_no_targeting_always_applies():
    merged = policy.merge_settings(
        [gpo_with([{"name": "everyone", "mount_point": "/mnt/c"}])], target()
    )
    assert len(merged["drive_maps"]) == 1


def test_entry_targeting_uses_the_same_rules_as_the_policy_object():
    """What 'matches' means must not depend on where it is written."""
    applies, _ = policy.targeting_matches({"os": ["debian-12"]}, target())
    assert applies is False
    applies, _ = policy.targeting_matches({"hostname_pattern": "ws-*"}, target())
    assert applies is True
    applies, _ = policy.targeting_matches({"ip_ranges": ["10.20.0.0/24"]}, target())
    assert applies is True
