"""Remote desktop: the connection file, and what a collection will accept."""

from __future__ import annotations

import pytest

from odm import remotedesktop, routes_remotedesktop


def test_the_connection_file_carries_the_user_name():
    # Not a convenience: an RDP client sends this in its first packet and the
    # broker keys its affinity on it. Without it somebody lands on whichever
    # host is least busy each time, which is the opposite of a collection.
    body = remotedesktop.rdp_file(
        broker="rdbroker.corp.example.internal",
        username="jdoe",
        collection={"name": "Finance", "kind": "desktop"},
    )
    assert "username:s:jdoe" in body
    assert "full address:s:rdbroker.corp.example.internal:3389" in body
    # Windows clients are strict about the line ending in this format.
    assert body.endswith("\r\n") and "\r\n" in body


def test_a_published_application_replaces_the_desktop():
    body = remotedesktop.rdp_file(
        broker="rdbroker.corp.example.internal",
        username="jdoe",
        collection={
            "name": "ERP",
            "kind": "remoteapp",
            "app_path": "/usr/bin/erp-client",
            "app_name": "ERP",
        },
    )
    assert "remoteapplicationmode:i:1" in body
    assert "remoteapplicationprogram:s:/usr/bin/erp-client" in body


def test_a_full_desktop_says_nothing_about_applications():
    body = remotedesktop.rdp_file(
        broker="b.example.org", username="jdoe", collection={"name": "Desks", "kind": "desktop"}
    )
    assert "remoteapplicationmode" not in body


@pytest.mark.parametrize(
    "value",
    ["/srv/shares/profiles", "fs01/Profiles", "//fs01", "//fs01/../etc", "//fs01/a;rm -rf /"],
)
def test_a_profile_share_that_is_not_a_share_is_refused(value):
    with pytest.raises(remotedesktop.RemoteDesktopError):
        remotedesktop.validate_share(value)


def test_a_share_may_name_a_path_inside_itself():
    """A collection and a roaming-profile policy are best kept apart, and the
    way to keep them apart is a path per person, the same as the policy takes."""
    assert (
        remotedesktop.validate_share("//fs01/rds-profiles/%username%")
        == "//fs01/rds-profiles/%username%"
    )
    assert remotedesktop.validate_share("//fs01/profiles/teams/%username%/") == (
        "//fs01/profiles/teams/%username%"
    )


def test_no_profile_share_is_a_collection_without_profile_disks():
    """Remote desktop must not need a file server before it works at all."""
    assert remotedesktop.validate_share("") == ""
    assert remotedesktop.validate_share(None) == ""


def test_a_windows_style_share_is_accepted_and_normalised():
    assert remotedesktop.validate_share(r"\\fs01\Profiles") == "//fs01/Profiles"


def test_a_published_application_needs_a_program():
    with pytest.raises(remotedesktop.RemoteDesktopError):
        remotedesktop.validate_app("remoteapp", "")
    with pytest.raises(remotedesktop.RemoteDesktopError):
        remotedesktop.validate_app("remoteapp", "erp-client")
    # A full desktop has no program, and asking for one would be wrong.
    assert remotedesktop.validate_app("desktop", "anything") == ""


def test_the_host_is_told_only_what_it_needs():
    # Who may connect is enforced by the directory and the broker, not by
    # handing every session host the list.
    task = remotedesktop.host_task(
        {
            "name": "Finance",
            "kind": "desktop",
            "app_path": "",
            "profile_share": "//fs01/Profiles",
            "profile_gb": 10,
            "idle_minutes": 60,
            "disconnected_minutes": 120,
        }
    )
    assert "principals" not in task
    assert task["profile_share"] == "//fs01/Profiles"


def test_a_new_session_is_spread_and_a_returning_one_is_not():
    task = remotedesktop.broker_task(
        {
            "name": "Finance",
            "balance_method": "roundrobin",
            "disconnected_minutes": 120,
            "idle_minutes": 60,
        },
        ["a.example.org", "b.example.org"],
    )
    assert task["balance_method"] == "roundrobin"
    assert [entry["host"] for entry in task["hosts"]] == ["a.example.org", "b.example.org"]


def test_the_affinity_window_outlives_the_session_it_protects():
    # A person whose session is still being held has their profile disk
    # mounted on that host, exclusively. Sending them anywhere else refuses
    # the logon, so the broker must keep pointing at that host for at least as
    # long as the session can survive.
    disconnected, idle = 120, 60
    window = remotedesktop.affinity_minutes(disconnected, idle)
    assert window > disconnected + idle, "affinity expires while a session can still exist"


def test_sessions_kept_forever_keep_their_host_forever():
    # Zero means never, as it does in Windows. An affinity that expired would
    # send somebody to a host that cannot mount a profile the old host holds.
    assert remotedesktop.affinity_minutes(0, 0) >= 7 * 24 * 60


def test_a_short_timeout_still_gets_a_usable_window():
    # Not just disconnected + idle: the host ends the session on its own
    # clock, and the two are not synchronised to the second.
    assert remotedesktop.affinity_minutes(5, 0) > 5


def test_a_host_that_shares_a_machine_with_the_broker_moves_aside():
    """They both bound 3389, xrdp won, and haproxy exited with "cannot bind
    socket (Address already in use)" — so the broker was not brokering at all
    and every client reached one host directly."""
    from odm import remotedesktop

    row = {
        "name": "desktops", "kind": "desktop", "app_path": "",
        "profile_share": "//fs01/profiles", "profile_gb": 10,
        "idle_minutes": 30, "disconnected_minutes": 60,
        "broker_fqdn": "rdb01.corp.example.internal",
    }
    beside = remotedesktop.host_task(row, "rdb01.corp.example.internal")
    assert beside["rdp_port"] == remotedesktop.HOST_BESIDE_BROKER_PORT

    apart = remotedesktop.host_task(row, "rdh01.corp.example.internal")
    assert apart["rdp_port"] == remotedesktop.DEFAULT_RDP_PORT

    # And the broker reaches each host where it actually listens.
    broker = remotedesktop.broker_task(
        row, ["rdb01.corp.example.internal", "rdh01.corp.example.internal"]
    )
    ports = {entry["host"]: entry["port"] for entry in broker["hosts"]}
    assert ports["rdb01.corp.example.internal"] == remotedesktop.HOST_BESIDE_BROKER_PORT
    assert ports["rdh01.corp.example.internal"] == remotedesktop.DEFAULT_RDP_PORT


class _FakeConn:
    """Records what the existence check looked for."""

    def __init__(self, found: bool = True) -> None:
        self.found = found
        self.asked: tuple[str, str] | None = None

    async def fetchval(self, _sql: str, name: str, node: str) -> int | None:
        self.asked = (node, name)
        return 1 if self.found else None


async def test_only_the_share_is_checked_against_the_directory_of_shares():
    """A per-person path lives inside a share; it is not a share of its own.

    Matched whole, //fs01/rds-profiles/%username% came back as "not a share on
    this domain" — which is a share nobody could point a collection at without
    making one share per person.
    """
    conn = _FakeConn()
    await routes_remotedesktop._share_exists(conn, "//fs01/rds-profiles/%username%")
    assert conn.asked == ("fs01", "rds-profiles")


async def test_a_share_that_does_not_exist_is_still_refused():
    conn = _FakeConn(found=False)
    with pytest.raises(remotedesktop.RemoteDesktopError) as refused:
        await routes_remotedesktop._share_exists(conn, "//fs01/nope/%username%")
    # The share it looked for, not the path typed: the path is not the thing
    # that has to exist.
    assert "//fs01/nope is not a share" in str(refused.value)
