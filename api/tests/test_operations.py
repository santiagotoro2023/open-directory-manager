"""Phase 8: replication, backups and the default policies."""

from __future__ import annotations

import pytest
from conftest import BASE_DN  # noqa: F401  (environment setup ordering)

from odm import backup, replication
from odm.config import Settings, get_settings
from odm.policy_schema import PolicySettings
from odm.routes_policy import _default_dc_settings, _default_domain_settings

SHOWREPL = """Default-First-Site-Name\\DC1
DSA Options: 0x00000001
DSA object GUID: 11111111-1111-1111-1111-111111111111
DSA invocationId: 22222222-2222-2222-2222-222222222222

==== INBOUND NEIGHBORS ====

DC=corp,DC=example,DC=internal
\tDefault-First-Site-Name\\DC2 via RPC
\t\tDSA object GUID: 33333333-3333-3333-3333-333333333333
\t\tLast attempt @ Thu Aug 28 09:15:02 2026 CEST was successful

CN=Configuration,DC=corp,DC=example,DC=internal
\tDefault-First-Site-Name\\DC2 via RPC
\t\tDSA object GUID: 33333333-3333-3333-3333-333333333333
\t\tLast attempt @ Thu Aug 28 09:15:04 2026 CEST failed, result 1256
\t\t5 consecutive failure(s).

==== OUTBOUND NEIGHBORS ====

DC=corp,DC=example,DC=internal
\tDefault-First-Site-Name\\DC2 via RPC
"""


# ------------------------------------------------------------ replication ---


def test_showrepl_is_parsed_into_inbound_partners(monkeypatch):
    monkeypatch.setattr(replication, "_run", lambda *args: SHOWREPL)
    status = replication.status(get_settings())

    assert status["server"] == "dc1.corp.example.internal"
    assert len(status["inbound"]) == 2

    domain, configuration = status["inbound"]
    assert domain["naming_context"] == "DC=corp,DC=example,DC=internal"
    assert domain["partner"].endswith("DC2")
    assert domain["succeeded"] is True and domain["failures"] == 0

    assert configuration["succeeded"] is False
    assert configuration["failures"] == 5
    # One failing partner makes the whole picture unhealthy.
    assert status["healthy"] is False


def test_all_successful_replication_reads_as_healthy(monkeypatch):
    monkeypatch.setattr(
        replication, "_run", lambda *args: SHOWREPL.replace("failed, result 1256", "was successful")
    )
    assert replication.status(get_settings())["healthy"] is True


def test_outbound_and_kcc_sections_are_not_counted(monkeypatch):
    monkeypatch.setattr(replication, "_run", lambda *args: SHOWREPL)
    # The outbound section repeats the same naming context; only inbound counts.
    assert len(replication.status(get_settings())["inbound"]) == 2


@pytest.mark.parametrize(
    ("destination", "source", "naming_context"),
    [
        ("dc1; reboot", "dc2", "DC=corp,DC=example,DC=internal"),
        ("dc1", "dc2 && rm -rf /", "DC=corp,DC=example,DC=internal"),
        ("dc1", "dc2", "/etc/passwd"),
        ("dc1", "dc2", "$(whoami)"),
    ],
)
def test_hostile_replication_arguments_are_refused(destination, source, naming_context):
    with pytest.raises(replication.ReplicationError):
        replication.replicate(get_settings(), destination, source, naming_context)


# ---------------------------------------------------------------- backups ---


def backup_settings(tmp_path, keep: int = 2) -> Settings:
    return Settings(
        realm="corp.example.internal",
        domain="corp.example.internal",
        ldap_uri="ldaps://dc1.corp.example.internal",
        ldap_ca_cert="/nonexistent/ca.pem",
        database_url="postgresql://odm@localhost/odm",
        backup_dir=tmp_path,
        backup_keep=keep,
    )


def test_archives_are_listed_newest_first(tmp_path):
    settings = backup_settings(tmp_path)
    for index, name in enumerate(
        ["samba-backup-2026-01-01.tar.bz2", "samba-backup-2026-02-01.tar.bz2"]
    ):
        path = tmp_path / name
        path.write_bytes(b"x" * (index + 1))
        import os

        os.utime(path, (1_700_000_000 + index, 1_700_000_000 + index))

    listed = backup.archives(settings)
    assert [entry["path"].split("/")[-1] for entry in listed] == [
        "samba-backup-2026-02-01.tar.bz2",
        "samba-backup-2026-01-01.tar.bz2",
    ]


def test_prune_keeps_the_newest_and_removes_the_rest(tmp_path):
    settings = backup_settings(tmp_path, keep=2)
    import os

    for index in range(4):
        path = tmp_path / f"samba-backup-2026-0{index + 1}-01.tar.bz2"
        path.write_bytes(b"x")
        os.utime(path, (1_700_000_000 + index, 1_700_000_000 + index))

    removed = backup.prune(settings, settings.backup_keep)
    remaining = sorted(p.name for p in tmp_path.iterdir())
    assert len(removed) == 2
    assert remaining == ["samba-backup-2026-03-01.tar.bz2", "samba-backup-2026-04-01.tar.bz2"]


def test_prune_never_touches_anything_that_is_not_an_archive(tmp_path):
    settings = backup_settings(tmp_path, keep=0)
    (tmp_path / "important.conf").write_text("keep me")
    (tmp_path / "samba-backup-2026-01-01.tar.bz2").write_bytes(b"x")

    backup.prune(settings, settings.backup_keep)
    assert (tmp_path / "important.conf").exists()


def test_backups_report_unconfigured_rather_than_guessing():
    assert backup.configured(get_settings()) is False
    assert backup.archives(get_settings()) == []
    with pytest.raises(backup.BackupError):
        backup.directory(get_settings())


# ------------------------------------------------------- default policies ---


def test_the_default_policies_are_valid_policy_documents():
    settings = get_settings()
    # They go through the same validation as anything an operator writes.
    domain = PolicySettings(**_default_domain_settings(settings))
    controllers = PolicySettings(**_default_dc_settings(settings))

    assert domain.files[0].path == "/etc/issue.net"
    # The polling interval is a domain setting, not something the shipped
    # policy carries: a copy here would win over the console for every machine.
    assert domain.agent is None
    assert controllers.systemd_units[0].unit == "ssh.service"
    assert controllers.hbac_rules[0].principal == f"%{settings.admin_group}"
    assert controllers.hbac_rules[0].access == "allow"


def test_the_default_controller_policy_never_denies_by_itself():
    # A deny rule in the shipped default could strand every controller.
    settings = get_settings()
    assert all(
        rule["access"] == "allow" for rule in _default_dc_settings(settings)["hbac_rules"]
    )
