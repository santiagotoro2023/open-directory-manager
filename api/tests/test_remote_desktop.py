"""Remote desktop: the connection file, and what a collection will accept."""

from __future__ import annotations

import pytest

from odm import remotedesktop


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
    ["", "/srv/shares/profiles", "fs01/Profiles", "//fs01", "//fs01/../etc", "//fs01/a;rm -rf /"],
)
def test_a_profile_share_that_is_not_a_share_is_refused(value):
    with pytest.raises(remotedesktop.RemoteDesktopError):
        remotedesktop.validate_share(value)


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
