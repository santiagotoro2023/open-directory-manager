"""The domain's whole configuration, out as one file and back in from one."""

from __future__ import annotations

import pytest

from odm import domainexport


def test_a_file_from_another_product_or_another_format_is_refused():
    for bad in (None, [], "an export", {"hello": 1}, {"odm_export": 99}):
        with pytest.raises(domainexport.ImportError_):
            domainexport.check(bad)
    good = {"odm_export": domainexport.EXPORT_FORMAT}
    assert domainexport.check(good) is good


def test_a_credential_is_replaced_rather_than_dropped():
    """The reader has to be able to see that the setting exists and that its
    secret was withheld; a missing column reads as a missing setting."""
    section = {
        "radius_client": [
            {"name": "ap01", "secret": "hunter2"},
            {"name": "ap02", "secret": None},
        ],
        "file_share": [{"name": "profiles"}],
    }
    for table, columns in domainexport.SECRET_COLUMNS.items():
        for row in section.get(table, []):
            for column in columns:
                if row.get(column) not in (None, ""):
                    row[column] = domainexport.WITHHELD
    assert domainexport.withheld_in(section) == ["radius_client.secret (1)"]


def test_a_withheld_value_is_never_written_back():
    """An import that wrote the marker into the column would leave a domain
    whose RADIUS secret is the words '<withheld from the export>'."""
    row = {"name": "ap01", "secret": domainexport.WITHHELD}
    assert [key for key in row if row[key] != domainexport.WITHHELD] == ["name"]


def test_distinguished_names_are_rebased_onto_the_domain_being_imported_into():
    moved = domainexport.rewrite_dn(
        "CN=jdoe,OU=Staff,DC=old,DC=example,DC=org",
        "DC=old,DC=example,DC=org",
        "DC=corp,DC=example,DC=internal",
    )
    assert moved == "CN=jdoe,OU=Staff,DC=corp,DC=example,DC=internal"
    # The same domain is a no-op, and a name that is not under the old base is
    # left exactly as it was rather than being mangled.
    base = "DC=corp,DC=example,DC=internal"
    same = f"CN=jdoe,OU=Staff,{base}"
    assert domainexport.rewrite_dn(same, base, base) == same
    assert domainexport.rewrite_dn("CN=x,DC=other", "DC=old", "DC=new") == "CN=x,DC=other"


def test_containers_are_created_before_what_lives_in_them():
    names = [
        "OU=Desks,OU=Zurich,OU=Sites,DC=corp,DC=example,DC=internal",
        "OU=Sites,DC=corp,DC=example,DC=internal",
        "OU=Zurich,OU=Sites,DC=corp,DC=example,DC=internal",
    ]
    assert sorted(names, key=domainexport.depth) == [
        "OU=Sites,DC=corp,DC=example,DC=internal",
        "OU=Zurich,OU=Sites,DC=corp,DC=example,DC=internal",
        "OU=Desks,OU=Zurich,OU=Sites,DC=corp,DC=example,DC=internal",
    ]


def test_the_records_a_domain_writes_for_itself_are_not_imported():
    """A zone in the new domain already has its own, pointing at its own
    controllers rather than the ones the file was taken from."""
    kept = domainexport.importable_records(
        "example.org",
        [
            {"name": "@", "type": "SOA", "data": "dc1 hostmaster 1"},
            {"name": "@", "type": "NS", "data": "dc1.example.org."},
            {"name": "_ldap._tcp", "type": "SRV", "data": "0 100 389 dc1.example.org"},
            {"name": "DomainDnsZones", "type": "A", "data": "10.0.0.1"},
            {"name": "remote", "type": "A", "data": "10.0.0.7"},
        ],
    )
    assert kept == [{"name": "remote", "type": "A", "data": "10.0.0.7"}]


def test_bytes_survive_the_round_trip_rather_than_being_guessed_at():
    raw = b"\x00\x01\xfe"
    assert domainexport._restore(domainexport._plain(raw)) == raw
    assert domainexport._plain("plain") == "plain"


def test_the_summary_says_the_size_of_what_an_import_would_do():
    summary = domainexport.summarise(
        {
            "odm_export": 1,
            "taken_at": "2026-01-01T00:00:00+00:00",
            "version": "0.8.1",
            "domain": {"realm": "CORP.EXAMPLE.INTERNAL"},
            "directory": {"users": [{}, {}], "groups": [{}]},
            "dns": {"zones": [{"name": "example.org", "records": [{}, {}, {}]}]},
            "database": {"gpo": [{}, {}], "file_share": []},
            "withheld": ["radius_client.secret (1)"],
        }
    )
    assert summary["users"] == 2 and summary["groups"] == 1
    assert summary["organizational_units"] == 0 and summary["computers"] == 0
    assert summary["dns_zones"] == 1 and summary["dns_records"] == 3
    # Empty tables are not listed: a reader wants what is in the file.
    assert summary["tables"] == {"gpo": 2}
    assert summary["withheld"] == ["radius_client.secret (1)"]


def test_the_queue_and_the_audit_log_are_never_exported():
    """They are what happened, not what was configured, and a restore wants
    the domain the file describes rather than yesterday's work."""
    for volatile in ("audit_log", "node_task", "admin_session", "join_token", "totp_enrolment"):
        assert volatile in domainexport.VOLATILE_TABLES
