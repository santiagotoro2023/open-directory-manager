"""Token enrolment provisions a real Kerberos server, not just an account.

`net ads join` registers HOST/ and cifs/ service principal names as part of
joining; token enrolment (routes_join.py's redeem path) creates the computer
account directly with samba-tool instead, and used to stop there. A member
file server enrolled that way had an account with no SPN at all, so a client
asking the KDC for a ticket to "cifs/<host>" got "Server not found in
Kerberos database" — a cifs mount that never attaches, on a share whose
directory and POSIX ACLs are otherwise perfectly correct.
"""

from __future__ import annotations

from pathlib import Path

from odm import enrolment
from odm.config import get_settings

CONTAINER = "CN=Computers,DC=corp,DC=example,DC=internal"


def _fake_run(calls, keytab_bytes):
    def fake(*args):
        calls.append(args)
        if args[:2] == ("computer", "list"):
            return ""
        if args[:2] == ("domain", "exportkeytab"):
            path = Path(args[2])
            existing = path.read_bytes() if path.exists() else b""
            path.write_bytes(existing + keytab_bytes)
            return ""
        return ""

    return fake


def test_provisioning_a_new_machine_registers_host_and_cifs_spns(monkeypatch):
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(enrolment, "_run", _fake_run(calls, b"K"))

    keytab = enrolment.provision_machine(
        get_settings(), "fs1.corp.example.internal", CONTAINER
    )

    assert keytab == b"K" * 5  # the account principal plus 4 service principals

    spn_targets = {call[2] for call in calls if call[0] == "spn"}
    assert spn_targets == {
        "host/fs1",
        "host/fs1.corp.example.internal",
        "cifs/fs1",
        "cifs/fs1.corp.example.internal",
    }
    # Every SPN lands on the machine account, not on some other name.
    assert {call[3] for call in calls if call[0] == "spn"} == {"fs1$"}

    exported = [call[3] for call in calls if call[:2] == ("domain", "exportkeytab")]
    assert exported == [
        "--principal=fs1$@CORP.EXAMPLE.INTERNAL",
        "--principal=host/fs1@CORP.EXAMPLE.INTERNAL",
        "--principal=host/fs1.corp.example.internal@CORP.EXAMPLE.INTERNAL",
        "--principal=cifs/fs1@CORP.EXAMPLE.INTERNAL",
        "--principal=cifs/fs1.corp.example.internal@CORP.EXAMPLE.INTERNAL",
    ]


def test_a_bare_hostname_does_not_register_the_same_spn_twice(monkeypatch):
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(enrolment, "_run", _fake_run(calls, b"K"))

    keytab = enrolment.provision_machine(get_settings(), "fs1", CONTAINER)

    assert keytab == b"K" * 3  # account principal + host/ + cifs/, no fqdn duplicate
    spn_targets = {call[2] for call in calls if call[0] == "spn"}
    assert spn_targets == {"host/fs1", "cifs/fs1"}


def test_an_spn_that_already_exists_does_not_fail_reenrolment(monkeypatch):
    calls: list[tuple[str, ...]] = []

    def fake(*args):
        calls.append(args)
        if args[:2] == ("computer", "list"):
            return "fs1$"  # already enrolled
        if args[0] == "spn":
            raise enrolment.EnrolmentError("ldb_modify failed: Attribute or value exists")
        if args[:2] == ("domain", "exportkeytab"):
            Path(args[2]).write_bytes(b"K")
            return ""
        return ""

    monkeypatch.setattr(enrolment, "_run", fake)

    keytab = enrolment.provision_machine(
        get_settings(), "fs1.corp.example.internal", CONTAINER
    )
    assert keytab == b"K"
    assert any(call[:2] == ("user", "setpassword") for call in calls)
