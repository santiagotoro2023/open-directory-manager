"""Remote desktop: the connection file, and what a collection will accept."""

from __future__ import annotations

import pytest

from odm import remotedesktop, routes_remotedesktop

# One stored collection, as the row handed to host_task looks.
_ROW = {
    "name": "Desks",
    "kind": "desktop",
    "app_path": "",
    "profile_share": "//fs01/rds-profiles/%username%",
    "profile_gb": 10,
    "idle_minutes": 60,
    "disconnected_minutes": 120,
    "broker_fqdn": "rdbroker.corp.example.internal",
}


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


def test_a_session_may_not_start_without_its_profile_unless_that_is_asked_for():
    """A local home exists on one host and nowhere else, so somebody handed one
    has quietly stopped keeping their work where they think it is."""
    assert remotedesktop.host_task({**_ROW})["allow_local_home"] is False
    assert remotedesktop.host_task({**_ROW, "allow_local_home": True})["allow_local_home"] is True


def test_the_hosts_are_what_the_profile_share_has_to_let_in():
    """Not the people: the host mounts the share as itself, before anybody has
    a ticket, and creates and opens their disk image as itself."""
    entries = remotedesktop.profile_share_entries(
        [{"principal": "gsg_rds_users", "kind": "group", "access": "change", "inherit": True}],
        ["host1.corp.example.internal", "HOST2.corp.example.internal"],
    )
    assert {e["principal"] for e in entries} == {"gsg_rds_users", "HOST1$", "HOST2$"}
    # The group keeps what it had on the share and stops reaching inside the
    # directories the hosts make, so one person cannot open another's profile.
    group = next(e for e in entries if e["principal"] == "gsg_rds_users")
    assert group["access"] == "change" and group["inherit"] is False
    assert all(e["inherit"] for e in entries if e["principal"].endswith("$"))


def test_configuring_the_profile_share_twice_changes_nothing_the_second_time():
    hosts = ["host1.corp.example.internal"]
    once = remotedesktop.profile_share_entries([], hosts)
    assert remotedesktop.profile_share_entries(once, hosts) == once


# ------------------------------------------ two brokers, and one name for them


def test_a_standby_broker_is_carried_beside_the_primary_and_never_duplicated():
    assert remotedesktop.brokers(_ROW) == ["rdbroker.corp.example.internal"]
    both = remotedesktop.brokers({**_ROW, "broker_secondary_fqdn": "rd2.corp.example.internal"})
    assert both == ["rdbroker.corp.example.internal", "rd2.corp.example.internal"]
    # The same machine named twice is one broker, not two servers in haproxy.
    same = remotedesktop.brokers(
        {**_ROW, "broker_secondary_fqdn": "RDBROKER.corp.example.internal"}
    )
    assert same == ["rdbroker.corp.example.internal"]


def test_a_host_sharing_a_machine_with_either_broker_moves_xrdp_aside():
    """The standby owns 3389 on its machine too, whether or not it is the one
    clients are reaching today."""
    row = {**_ROW, "broker_secondary_fqdn": "rd2.corp.example.internal"}
    assert remotedesktop.host_task(row, "host1.corp.example.internal")["rdp_port"] == 3389
    assert remotedesktop.host_task(row, "rdbroker.corp.example.internal")["rdp_port"] == 3390
    assert remotedesktop.host_task(row, "rd2.corp.example.internal")["rdp_port"] == 3390


def test_clients_are_told_the_external_name_when_there_is_one():
    assert remotedesktop.connection_address(_ROW) == "rdbroker.corp.example.internal"
    external = {**_ROW, "external_fqdn": "remote.example.org"}
    assert remotedesktop.connection_address(external) == "remote.example.org"
    body = remotedesktop.rdp_file(
        broker=remotedesktop.connection_address(external), username="jdoe", collection=external
    )
    assert "full address:s:remote.example.org:3389" in body


def test_an_external_name_is_split_into_a_record_and_the_zone_holding_it():
    assert remotedesktop.dns_placement("remote.example.org") == ("remote", "example.org")
    assert remotedesktop.dns_placement("rd.corp.example.internal") == (
        "rd",
        "corp.example.internal",
    )


def test_only_a_fully_qualified_name_is_accepted_for_the_external_name():
    assert remotedesktop.validate_fqdn("  Remote.Example.ORG. ", "the external name") == (
        "remote.example.org"
    )
    assert remotedesktop.validate_fqdn("", "the external name") == ""
    for bad in ("remote", "remote..org", "-remote.example.org", "remote.example.org/x"):
        with pytest.raises(remotedesktop.RemoteDesktopError):
            remotedesktop.validate_fqdn(bad, "the external name")


def test_publishing_the_external_name_adds_what_is_missing_and_removes_what_is_stale():
    existing = [
        {"name": "remote", "type": "A", "data": "10.0.0.1"},
        {"name": "remote", "type": "A", "data": "10.0.0.9"},
        # Somebody else's record in the same zone stays where it is.
        {"name": "www", "type": "A", "data": "10.0.0.5"},
        {"name": "remote", "type": "TXT", "data": "hello"},
    ]
    add, remove = remotedesktop.external_records(existing, "remote", ["10.0.0.1", "10.0.0.2"])
    assert add == ["10.0.0.2"]
    assert remove == ["10.0.0.9"]

    # Publishing again changes nothing.
    settled = [{"name": "remote", "type": "A", "data": a} for a in ("10.0.0.1", "10.0.0.2")]
    assert remotedesktop.external_records(settled, "remote", ["10.0.0.1", "10.0.0.2"]) == ([], [])

    # And a collection that stops publishing takes its records with it.
    assert remotedesktop.external_records(settled, "remote", []) == ([], ["10.0.0.1", "10.0.0.2"])
