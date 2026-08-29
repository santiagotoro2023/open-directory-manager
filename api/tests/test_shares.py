"""File shares: what an access level becomes, and what is refused.

The access list is the only thing standing between "Engineers can read this"
and "everyone can write it", and it is rendered into setfacl arguments by
code no test had covered.
"""

from __future__ import annotations

import conftest  # noqa: F401  (environment setup ordering)
import pytest

from odm import shares


def entries(*raw):
    return shares.validate_entries(list(raw))


def test_read_and_write_are_different_access_lists():
    read = shares.acl_spec(entries({"principal": "Interns", "access": "read"}))
    write = shares.acl_spec(entries({"principal": "Engineers", "access": "change"}))

    assert "g:Interns:r-x" in read
    assert "g:Engineers:rwx" in write
    assert "g:Interns:rwx" not in read


def test_inheritance_adds_a_default_entry_and_omitting_it_does_not():
    """A default ACL is what makes a file created later carry the permission;
    without one only the directory itself is covered."""
    with_inherit = shares.acl_spec(entries({"principal": "Engineers", "access": "change"}))
    without = shares.acl_spec(
        entries({"principal": "Engineers", "access": "change", "inherit": False})
    )

    assert "d:g:Engineers:rwx" in with_inherit
    assert not any(spec.startswith("d:") for spec in without)


def test_a_user_entry_is_not_written_as_a_group():
    spec = shares.acl_spec(entries({"principal": "ada", "kind": "user", "access": "full"}))
    assert spec[0] == "u:ada:rwx"


@pytest.mark.parametrize(
    "path",
    ["/", "/etc", "/etc/samba", "/boot/grub", "/root", "/var/lib/samba", "/srv/../etc", "srv"],
)
def test_system_directories_are_never_shared(path):
    with pytest.raises(shares.ShareError):
        shares.validate_path(path)


@pytest.mark.parametrize(
    "name",
    ["", "-leading", "a" * 80, "name;rm -rf /", "na\nme", "[global]", "$(id)"],
)
def test_hostile_share_names_are_refused(name):
    with pytest.raises(shares.ShareError):
        shares.validate_name(name)


@pytest.mark.parametrize("principal", ["", "a;b", "a\nb", "%group", "x" * 80])
def test_hostile_principals_never_reach_setfacl(principal):
    with pytest.raises(shares.ShareError):
        shares.validate_entries([{"principal": principal, "access": "read"}])


def test_an_unknown_access_level_is_refused_rather_than_defaulted():
    with pytest.raises(shares.ShareError):
        shares.validate_entries([{"principal": "Engineers", "access": "everything"}])


def test_the_same_principal_cannot_be_granted_twice():
    """Two entries for one group would silently leave whichever setfacl saw
    last in force, which is not what the table showed."""
    with pytest.raises(shares.ShareError):
        shares.validate_entries(
            [
                {"principal": "Engineers", "access": "read"},
                {"principal": "engineers", "access": "full"},
            ]
        )


def test_the_task_the_agent_receives_carries_everything_it_needs():
    task = shares.as_task(
        {
            "name": "shared",
            "path": "/srv/shares/shared/",
            "comment": "Team files",
            "owner": "root",
            "owner_group": "Domain Admins",
            "browseable": True,
            "read_only": False,
            "entries": [{"principal": "Engineers", "access": "change", "inherit": True}],
        }
    )

    assert task["path"] == "/srv/shares/shared"  # the trailing slash is normalised
    assert task["acl"] == ["g:Engineers:rwx", "d:g:Engineers:rwx"]
    assert task["other"] == "---"
