"""Phase 3: GPO precedence, filtering, targeting and settings validation.

Precedence is resolved once, in the API, so this is where it gets proven.
"""

from __future__ import annotations

import base64

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


def test_grub_boot_splash_rejects_bad_input():
    for bad in (
        {"grub": {"splash_message": "line one\nline two"}},
        {"grub": {"splash_image": "not valid base64!!"}},
        {"grub": {"splash_image": base64.b64encode(b"not an image").decode()}},
        {"grub": {"splash_image_name": "../../etc/passwd"}},
        {"grub": {"splash_background": "not valid base64!!"}},
        {"grub": {"splash_background": base64.b64encode(b"not an image").decode()}},
        {"grub": {"splash_background_name": "../../etc/passwd"}},
    ):
        with pytest.raises(ValidationError):
            PolicySettings(**bad)


def test_grub_boot_splash_accepts_a_real_logo():
    png = base64.b64encode(b"\x89PNG\r\n\x1a\nrest of a real file").decode()
    settings = PolicySettings(
        grub={
            "boot_splash": True,
            "splash_message": "Starting up",
            "splash_image": png,
            "splash_image_name": "logo.png",
        }
    )
    assert settings.grub.boot_splash is True
    assert settings.grub.splash_message == "Starting up"
    assert settings.grub.splash_image_name == "logo.png"


def test_grub_boot_splash_accepts_a_real_background():
    png = base64.b64encode(b"\x89PNG\r\n\x1a\nrest of a real file").decode()
    settings = PolicySettings(
        grub={
            "boot_splash": True,
            "splash_background": png,
            "splash_background_name": "background.png",
        }
    )
    assert settings.grub.splash_background_name == "background.png"


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


def test_the_domain_authority_setting_becomes_the_general_settings(monkeypatch):
    """Certificates names an intent; the agent applies the settings it turns into."""
    from odm import ca, rsop
    from odm.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(ca, "initialised", lambda _settings: True)
    monkeypatch.setattr(ca, "root_pem", lambda _settings: "-----BEGIN CERTIFICATE-----\nroot\n")
    document = {
        "settings": {
            "certificates": {
                "trust_domain_authority": True,
                "browsers": True,
                "machine_certificate": True,
                "machine_certificate_path": "/etc/ssl/odm",
            },
            "browser": {"chromium": {"HomepageLocation": "https://intranet"}},
        }
    }
    rsop.attach_certificates(settings, document)
    resolved = document["settings"]
    assert resolved["trusted_certificates"] == [
        {"name": "domain-authority", "certificate_pem": "-----BEGIN CERTIFICATE-----\nroot\n"}
    ]
    assert resolved["browser"]["chromium"]["HomepageLocation"] == "https://intranet"
    assert resolved["browser"]["chromium"]["CACertificates"] == [
        "-----BEGIN CERTIFICATE-----\nroot\n"
    ]
    assert resolved["certificate_enrolment"][0]["profile"] == "client"
    assert resolved["certificate_enrolment"][0]["path"] == "/etc/ssl/odm"

    # Applied twice, it does not double anything.
    rsop.attach_certificates(settings, document)
    assert len(resolved["trusted_certificates"]) == 1
    assert len(resolved["browser"]["chromium"]["CACertificates"]) == 1
    assert len(resolved["certificate_enrolment"]) == 1


def test_without_an_authority_the_setting_says_so_and_touches_nothing(monkeypatch):
    from odm import ca, rsop
    from odm.config import get_settings

    monkeypatch.setattr(ca, "initialised", lambda _settings: False)
    document = {"settings": {"certificates": {"trust_domain_authority": True, "browsers": True}}}
    rsop.attach_certificates(get_settings(), document)
    assert "unavailable" in document["settings"]["certificates"]
    assert "trusted_certificates" not in document["settings"]


def test_a_wifi_network_is_validated_for_its_security():
    import pytest

    from odm.policy_schema import WifiNetwork

    WifiNetwork(ssid="Corp", security="wpa-eap")
    WifiNetwork(ssid="Guest", security="wpa-psk", psk="correct horse battery")
    with pytest.raises(ValueError):
        WifiNetwork(ssid="Guest", security="wpa-psk", psk="short")
    with pytest.raises(ValueError):
        WifiNetwork(ssid="Corp", security="wpa-eap", psk="a key that does not belong")
    with pytest.raises(ValueError):
        WifiNetwork(ssid="Corp", certificate_path="relative/path")


def test_regional_settings_are_validated_as_locales_layouts_and_zones():
    import pytest

    from odm.policy_schema import Regional

    Regional(locale="de_CH.UTF-8", keyboard_layout="ch", keyboard_variant="de_nodeadkeys",
             timezone="Europe/Zurich", additional_locales=["fr_CH.UTF-8"])
    with pytest.raises(ValueError):
        Regional(locale="german")
    with pytest.raises(ValueError):
        Regional(keyboard_layout="ch; rm -rf /")
    with pytest.raises(ValueError):
        Regional(timezone="../../etc/passwd")


def test_logon_hours_rules_take_principals_days_and_clock_times():
    import pytest

    from odm.policy_schema import LogonHoursRule

    LogonHoursRule(principal="%Sales", days=["mon", "fri"], start="07:00", end="19:00")
    LogonHoursRule(principal="carol", days=["fri"], start="22:00", end="06:00", sign_out=True)
    with pytest.raises(ValueError):
        LogonHoursRule(principal="%Sales", days=[], start="07:00", end="19:00")
    with pytest.raises(ValueError):
        LogonHoursRule(principal="%Sales", days=["monday"], start="07:00", end="19:00")
    with pytest.raises(ValueError):
        LogonHoursRule(principal="%Sales", days=["mon"], start="7am", end="19:00")
    with pytest.raises(ValueError):
        LogonHoursRule(principal="bad\\name", days=["mon"])


def test_a_web_app_needs_a_web_address_and_a_plain_name():
    import pytest

    from odm.policy_schema import WebApp

    WebApp(name="Outlook", url="https://outlook.office.com/mail/", categories=["Office"])
    with pytest.raises(ValueError):
        WebApp(name="Outlook", url="outlook.office.com")
    with pytest.raises(ValueError):
        WebApp(name="Outlook", url="https://x.example/a b")
    with pytest.raises(ValueError):
        WebApp(name="Out[look]", url="https://x.example/")
    with pytest.raises(ValueError):
        WebApp(name="Outlook", url="https://x.example/", categories=["Office;Exec=rm"])


def test_the_dict_merge_does_not_take_the_targets_name():
    """A dict category once shadowed the target that per-entry targeting is
    matched against, so every targeted entry after the first dict category
    was matched against a settings dict."""
    from odm.policy import Gpo, Target, merge_settings

    target = Target(dn="CN=ws01", hostname="ws01", os_id="debian",
                    group_dns=[], ip_addresses=())
    gpos = [
        Gpo(guid="a", display_name="a", enabled=True, security_filter=[], targeting=None,
            settings={"screen_lock": {"idle_minutes": 5}}),
        Gpo(guid="b", display_name="b", enabled=True, security_filter=[], targeting=None,
            settings={"files": [
                {"path": "/etc/here", "targeting": {"hostname_pattern": "ws*"}},
                {"path": "/etc/not", "targeting": {"hostname_pattern": "srv*"}},
            ]}),
    ]
    merged = merge_settings(gpos, target)
    assert [entry["path"] for entry in merged["files"]] == ["/etc/here"]


def test_a_web_app_icon_may_be_uploaded_as_a_png_data_url():
    import pytest

    from odm.policy_schema import WebApp

    teams = "https://teams.microsoft.com/"
    WebApp(name="Teams", url=teams, icon_url="data:image/png;base64,UE5H")
    with pytest.raises(ValueError):
        WebApp(name="Teams", url=teams, icon_url="data:text/html;base64,PGh0bWw+")
    with pytest.raises(ValueError):
        WebApp(name="Teams", url=teams, icon_url="https://x.example/" + "a" * 2100)


def test_device_control_takes_usb_ids_as_lsusb_prints_them():
    import pytest

    from odm.policy_schema import DeviceControl

    rule = DeviceControl(bluetooth="block", camera="block", allowed_usb=["046D:085E"])
    assert rule.allowed_usb == ["046d:085e"]
    with pytest.raises(ValueError):
        DeviceControl(allowed_usb=["logitech"])
    with pytest.raises(ValueError):
        DeviceControl(camera="maybe")


def test_computer_name_templates_render_and_recognise_their_own_names():
    import pytest

    from odm import naming
    from odm.policy_schema import ComputerNames

    ComputerNames(template="WS-{n:4}")
    ComputerNames(template="LT-{serial}")
    with pytest.raises(ValueError):
        ComputerNames(template="WS")
    with pytest.raises(ValueError):
        ComputerNames(template="WS {n}")
    assert naming.render("WS-{n:4}", number=42) == "WS-0042"
    assert naming.render("ws{n}", number=7) == "ws7"
    assert naming.render("LT-{serial}", serial="PF-3X9/Q") == "LT-pf3x9q"
    assert naming.fits("WS-{n:4}", "ws-0042")
    assert naming.fits("WS-{n:4}", "WS-12")
    assert not naming.fits("WS-{n:4}", "ws-0042b")
    assert not naming.fits("WS-{n:4}", "alice-laptop")
    assert naming.describe("WS-{n:4}") == {"example": "WS-0042"}
