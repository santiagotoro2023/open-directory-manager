"""Phase 3: GPO precedence, filtering, targeting and settings validation.

Precedence is resolved once, in the API, so this is where it gets proven.
"""

from __future__ import annotations

import pytest
from conftest import BASE_DN
from pydantic import ValidationError

from odm import policy
from odm.policy_schema import PolicySettings

DOMAIN = BASE_DN
CORP = f"OU=Corp,{BASE_DN}"
SALES = f"OU=Sales,OU=Corp,{BASE_DN}"
WS = f"CN=ws01,OU=Sales,OU=Corp,{BASE_DN}"


def gpo(guid: str, /, **settings) -> policy.Gpo:
    return policy.Gpo(
        guid=guid,
        display_name=guid,
        enabled=settings.pop("enabled", True),
        settings=settings.pop("settings", {}),
        security_filter=settings.pop("security_filter", []),
        targeting=settings.pop("targeting", {}),
    )


def resolve(links, gpos, *, blocked=(), target=None):
    ordered, skipped = policy.resolve_order(
        chain=policy.container_chain(WS, DOMAIN),
        links=links,
        gpos={g.guid: g for g in gpos},
        blocked=set(blocked),
        target=target or policy.Target(dn=WS, hostname="ws01"),
    )
    return [g.guid for g in ordered], skipped


# ------------------------------------------------------------------- chain ---


def test_container_chain_runs_domain_first():
    assert policy.container_chain(WS, DOMAIN) == [DOMAIN, CORP, SALES]


def test_container_chain_of_a_direct_child():
    assert policy.container_chain(f"CN=ws01,{DOMAIN}", DOMAIN) == [DOMAIN]


def test_container_chain_outside_the_domain_is_empty():
    assert policy.container_chain("CN=ws01,DC=other,DC=example", DOMAIN) == []


# -------------------------------------------------------------- precedence ---


def test_closer_container_wins():
    order, _ = resolve(
        [
            policy.Link("domain-gpo", DOMAIN, 1),
            policy.Link("sales-gpo", SALES, 1),
        ],
        [gpo("domain-gpo"), gpo("sales-gpo")],
    )
    # Applied last wins, so the OU-level GPO comes last.
    assert order == ["domain-gpo", "sales-gpo"]


def test_lower_link_order_wins_within_a_container():
    order, _ = resolve(
        [policy.Link("first", SALES, 1), policy.Link("second", SALES, 2)],
        [gpo("first"), gpo("second")],
    )
    assert order == ["second", "first"]


def test_disabled_link_and_disabled_gpo_are_skipped():
    order, skipped = resolve(
        [
            policy.Link("off-link", SALES, 1, enabled=False),
            policy.Link("off-gpo", SALES, 2),
        ],
        [gpo("off-link"), gpo("off-gpo", enabled=False)],
    )
    assert order == []
    assert {s["reason"] for s in skipped} == {"link disabled", "gpo disabled"}


def test_block_inheritance_drops_everything_above():
    order, skipped = resolve(
        [
            policy.Link("domain-gpo", DOMAIN, 1),
            policy.Link("corp-gpo", CORP, 1),
            policy.Link("sales-gpo", SALES, 1),
        ],
        [gpo("domain-gpo"), gpo("corp-gpo"), gpo("sales-gpo")],
        blocked=[SALES],
    )
    assert order == ["sales-gpo"]
    assert {s["reason"] for s in skipped} == {"inheritance blocked"}


def test_enforced_links_survive_block_inheritance_and_outrank_everything():
    order, _ = resolve(
        [
            policy.Link("domain-enforced", DOMAIN, 1, enforced=True),
            policy.Link("sales-gpo", SALES, 1),
        ],
        [gpo("domain-enforced"), gpo("sales-gpo")],
        blocked=[SALES],
    )
    assert order == ["sales-gpo", "domain-enforced"]


def test_highest_enforced_link_wins_among_enforced():
    order, _ = resolve(
        [
            policy.Link("domain-enforced", DOMAIN, 1, enforced=True),
            policy.Link("corp-enforced", CORP, 1, enforced=True),
        ],
        [gpo("domain-enforced"), gpo("corp-enforced")],
    )
    assert order == ["corp-enforced", "domain-enforced"]


# ----------------------------------------------------- filtering, targeting ---


def test_security_filtering_requires_membership():
    engineers = f"CN=Engineers,{CORP}"
    filtered = gpo("filtered", security_filter=[engineers])
    links = [policy.Link("filtered", SALES, 1)]

    order, skipped = resolve(links, [filtered])
    assert order == [] and skipped[0]["reason"] == "security filtering"

    order, _ = resolve(
        links,
        [filtered],
        target=policy.Target(dn=WS, hostname="ws01", group_dns=(engineers,)),
    )
    assert order == ["filtered"]


@pytest.mark.parametrize(
    ("targeting", "target", "applies"),
    [
        ({"os": ["debian-13"]}, policy.Target(dn=WS, os_id="debian-13"), True),
        ({"os": ["debian-13"]}, policy.Target(dn=WS, os_id="debian-12"), False),
        ({"hostname_pattern": "ws-*"}, policy.Target(dn=WS, hostname="ws-07"), True),
        ({"hostname_pattern": "ws-*"}, policy.Target(dn=WS, hostname="srv-07"), False),
        (
            {"ip_ranges": ["10.10.0.0/16"]},
            policy.Target(dn=WS, ip_addresses=("10.10.4.9",)),
            True,
        ),
        (
            {"ip_ranges": ["10.10.0.0/16"]},
            policy.Target(dn=WS, ip_addresses=("192.168.1.4",)),
            False,
        ),
        ({"ip_ranges": ["not-a-range"]}, policy.Target(dn=WS, ip_addresses=("10.0.0.1",)), False),
    ],
)
def test_item_level_targeting(targeting, target, applies):
    assert policy.in_scope(gpo("g", targeting=targeting), target)[0] is applies


# ------------------------------------------------------------------- merge ---


def test_later_gpo_overrides_the_same_setting_and_keeps_the_others():
    base = gpo(
        "base",
        settings={
            "files": [{"path": "/etc/motd", "content": "old"}, {"path": "/etc/issue"}],
            "systemd_units": [{"unit": "ssh.service", "state": "enabled"}],
        },
    )
    override = gpo("override", settings={"files": [{"path": "/etc/motd", "content": "new"}]})

    merged = policy.merge_settings([base, override])
    motd = next(f for f in merged["files"] if f["path"] == "/etc/motd")
    assert motd["content"] == "new"
    assert {f["path"] for f in merged["files"]} == {"/etc/motd", "/etc/issue"}
    assert merged["systemd_units"][0]["unit"] == "ssh.service"


def test_dict_categories_merge_one_level_deep():
    merged = policy.merge_settings(
        [
            gpo("a", settings={"browser": {"chromium": {"HomepageLocation": "https://a"}}}),
            gpo("b", settings={"browser": {"firefox": {"Homepage": {"URL": "https://b"}}}}),
        ]
    )
    assert merged["browser"]["chromium"]["HomepageLocation"] == "https://a"
    assert merged["browser"]["firefox"]["Homepage"]["URL"] == "https://b"


def test_serial_changes_only_when_the_outcome_changes():
    def build(content):
        return policy.effective_policy(
            chain=policy.container_chain(WS, DOMAIN),
            links=[policy.Link("g", SALES, 1)],
            gpos={"g": gpo("g", settings={"files": [{"path": "/etc/motd", "content": content}]})},
            blocked=set(),
            target=policy.Target(dn=WS, hostname="ws01"),
        )

    assert build("same")["serial"] == build("same")["serial"]
    assert build("same")["serial"] != build("different")["serial"]


# -------------------------------------------------------------- validation ---


def test_settings_reject_dangerous_input():
    for bad in (
        {"files": [{"path": "../../etc/shadow"}]},
        {"files": [{"path": "/etc/motd", "mode": "rwx"}]},
        {"systemd_units": [{"unit": "ssh", "state": "enabled"}]},
        {"cron": [{"name": "x", "schedule": "whenever", "command": "true"}]},
        {"sudo_rules": [{"name": "x", "users": ["ada"], "commands": ["rm -rf /"]}]},
        {"sudo_rules": [{"name": "x", "users": ["ada) ALL=(ALL"], "commands": ["ALL"]}]},
        {"drive_maps": [{"name": "s", "unc": "not-a-share", "mount_point": "/mnt/s"}]},
        {"hbac_rules": [{"principal": "ada\\nroot"}]},
        {"files": [{"path": "/etc/motd", "unexpected": "field"}]},
    ):
        with pytest.raises(ValidationError):
            PolicySettings(**bad)


def test_settings_accept_a_realistic_policy():
    settings = PolicySettings(
        files=[{"path": "/etc/motd", "content": "Managed by ODM\n", "mode": "0644"}],
        scripts=[{"trigger": "startup", "name": "inventory", "content": "#!/bin/sh\nid\n"}],
        systemd_units=[{"unit": "telnet.socket", "state": "masked"}],
        cron=[{"name": "trim", "schedule": "0 3 * * 0", "command": "/usr/sbin/fstrim -a"}],
        drive_maps=[{"name": "shared", "unc": "//fs01/shared", "mount_point": "/mnt/shared"}],
        sudo_rules=[
            {"name": "helpdesk", "users": ["%Helpdesk"], "commands": ["/usr/bin/systemctl"]}
        ],
        hbac_rules=[{"principal": "%Engineers", "service": "ssh", "access": "allow"}],
        browser={"chromium": {"HomepageLocation": "https://intranet.example.org"}},
        wallpaper={"uri": "file:///usr/share/backgrounds/corp.png"},
    )
    stored = settings.stored()
    assert "firewall" not in stored  # empty categories are not persisted
    assert stored["drive_maps"][0]["unc"] == "//fs01/shared"


def test_a_share_written_the_way_a_file_manager_shows_it_is_accepted():
    """smb://server/share is what a file manager displays and what gets pasted
    into the field; the mount takes //server/share. Refusing it made a correct
    entry read as a wrong one."""
    from odm.policy_schema import PolicySettings

    for written in ("smb://fs01/shared", "SMB://fs01/shared", "cifs://fs01/shared",
                    "\\\\fs01\\shared"):
        settings = PolicySettings(
            drive_maps=[{"name": "shared", "unc": written, "mount_point": "/mnt/shared"}]
        )
        assert settings.drive_maps[0].unc == "//fs01/shared", written


def test_a_target_in_a_group_can_be_filtered_on(monkeypatch):
    """nested_groups describes each group — DN, account name, SID — and Target
    wants the distinguished names. Handing it the whole description made every
    filtering decision fail on 'dict' object has no attribute 'lower', which
    reached an operator as a 500 on the Policy tab of any object in a group.
    """
    from odm import directory, objects, rsop
    from odm.config import get_settings

    group = f"CN=Testers,{BASE_DN}"
    monkeypatch.setattr(
        objects, "get", lambda *a, **k: {"distinguishedName": f"CN=t,{BASE_DN}", "cn": "t"}
    )
    monkeypatch.setattr(
        directory,
        "nested_groups",
        lambda *a, **k: [{"dn": group, "sam_account_name": "Testers", "sid": "S-1-5-21-1"}],
    )
    target = rsop.target_facts(None, get_settings(), f"CN=t,{BASE_DN}")
    assert target.group_dns == (group,)

    # And the decision it exists for now actually runs.
    filtered = policy.Gpo(
        guid="g", display_name="Filtered", enabled=True, settings={},
        security_filter=[group],
    )
    applies, why = policy.in_scope(filtered, target)
    assert applies, why
