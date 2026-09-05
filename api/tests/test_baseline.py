"""The domain measured against a security checklist."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from odm import baseline

NOW = datetime(2026, 9, 5, tzinfo=UTC)


def user(name: str, **fields):
    return {"name": name, "disabled": False, "password_never_expires": False,
            "last_logon": NOW, **fields}


def test_a_disabled_account_is_not_a_dormant_one():
    """It is already off; reporting it as unused would bury the ones that are
    not."""
    check = baseline.stale_accounts(
        [
            user("ada"),
            user("bob", disabled=True, last_logon=NOW - timedelta(days=900)),
            user("cai", last_logon=NOW - timedelta(days=400)),
        ],
        90,
        NOW,
    )
    assert check.severity == "warning"
    assert check.detail == ["cai"]


def test_an_account_that_has_never_signed_in_counts_as_dormant():
    check = baseline.stale_accounts([user("ada", last_logon=None)], 90, NOW)
    assert check.count == 1


def test_a_domain_with_no_administrator_is_the_worst_finding():
    assert baseline.privileged_accounts([]).severity == "critical"
    assert baseline.privileged_accounts(["ada"]).severity == "ok"
    assert baseline.privileged_accounts([f"a{n}" for n in range(9)]).severity == "advisory"


def test_an_administrator_signing_in_with_a_password_alone_is_critical():
    check = baseline.second_factor(["ada", "bob"], {"ada"})
    assert check.severity == "critical"
    assert check.detail == ["bob"]
    assert baseline.second_factor(["ada"], {"ada"}).severity == "ok"


def test_a_password_policy_is_measured_against_the_usual_baseline():
    weak = baseline.password_policy(
        {"min_length": 7, "complexity": False, "lockout_threshold": 0}
    )
    assert weak.severity == "warning"
    assert weak.count == 3
    strong = baseline.password_policy(
        {"min_length": 14, "complexity": True, "lockout_threshold": 5}
    )
    assert strong.severity == "ok"
    assert baseline.password_policy(None).severity == "unknown"


def test_a_domain_that_has_never_been_backed_up_is_critical():
    assert baseline.backups(None, NOW).severity == "critical"
    assert baseline.backups(NOW - timedelta(days=2), NOW).severity == "ok"
    assert baseline.backups(NOW - timedelta(days=30), NOW).severity == "critical"


def test_agents_are_measured_as_a_proportion_rather_than_a_count():
    """One machine off in a fleet of a thousand is not the same finding as one
    machine off out of two."""
    assert baseline.agents_reporting(100, 1, 24).severity == "warning"
    assert baseline.agents_reporting(2, 1, 24).severity == "critical"
    assert baseline.agents_reporting(100, 0, 24).severity == "ok"
    assert baseline.agents_reporting(0, 0, 24).severity == "unknown"


def test_a_machine_with_no_encrypted_volume_is_named():
    check = baseline.encryption(
        [
            {"hostname": "laptop01", "volumes": [{"device": "/dev/sda1", "encrypted": False}]},
            {"hostname": "laptop02", "volumes": [{"device": "/dev/sda2", "encrypted": True}]},
        ]
    )
    assert check.detail == ["laptop01"]


def test_a_delegation_over_the_whole_domain_is_worth_knowing_about():
    check = baseline.delegation(
        [
            {"principal": "Helpdesk", "role_name": "helpdesk", "scope_dn": "DC=corp,DC=example"},
            {
                "principal": "Sales admins",
                "role_name": "helpdesk",
                "scope_dn": "OU=Sales,DC=corp,DC=example",
            },
        ]
    )
    assert check.severity == "advisory"
    assert check.count == 1


def test_the_report_counts_what_it_found():
    checks = [
        baseline.Check("a", "A", "ok", ""),
        baseline.Check("b", "B", "critical", ""),
        baseline.Check("c", "C", "critical", ""),
    ]
    assert baseline.score(checks)["critical"] == 2
    assert baseline.score(checks)["ok"] == 1
