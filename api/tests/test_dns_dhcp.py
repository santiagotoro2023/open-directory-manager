"""Phase 6: DNS and DHCP input validation.

Both layers hand values to something outside the API — samba-tool's argv and
Kea's configuration — so what they accept is a security boundary, and that is
what these tests pin down.
"""

from __future__ import annotations

import pytest
from conftest import BASE_DN  # noqa: F401  (import for environment setup ordering)

from odm import dns, kea
from odm.config import get_settings

# --------------------------------------------------------------------- DNS ---


@pytest.mark.parametrize(
    "zone",
    [
        "corp.example.internal",
        "10.in-addr.arpa",
        "corp.example.internal.",  # trailing dot is normalised away
        # Active Directory provisions this zone itself; refusing the name made
        # the domain's own service-location zone unreadable in the console.
        "_msdcs.corp.example.internal",
    ],
)
def test_valid_zones_are_accepted(zone):
    assert dns.validate_zone(zone) == zone.rstrip(".")


@pytest.mark.parametrize(
    "zone",
    [
        "",
        " ",
        "-leading.example",
        "space in.example",
        "semi;colon.example",
        "back`tick.example",
        "a" * 300,
        "zone.example --force",
        "$(whoami).example",
    ],
)
def test_hostile_zone_names_are_refused(zone):
    with pytest.raises(dns.DnsError):
        dns.validate_zone(zone)


@pytest.mark.parametrize("name", ["@", "*", "dc1", "_ldap._tcp", "a.b.c"])
def test_valid_record_names_are_accepted(name):
    assert dns.validate_name(name) == name


@pytest.mark.parametrize("name", ["", "two words", "semi;colon", "-x", "/etc/passwd"])
def test_hostile_record_names_are_refused(name):
    with pytest.raises(dns.DnsError):
        dns.validate_name(name)


def test_unsupported_record_types_are_refused():
    assert dns.validate_type("a") == "A"
    with pytest.raises(dns.DnsError):
        dns.validate_type("DNSKEY")


@pytest.mark.parametrize(
    ("record_type", "data", "expected"),
    [
        ("A", "10.0.0.10", "10.0.0.10"),
        ("AAAA", "2001:db8::1", "2001:db8::1"),
        ("CNAME", "dc1.corp.example.internal.", "dc1.corp.example.internal."),
        ("MX", "10 mail.corp.example.internal", "10 mail.corp.example.internal"),
        ("SRV", "0 100 389 dc1.corp.example.internal", "0 100 389 dc1.corp.example.internal"),
        ("TXT", '"v=spf1 -all"', "v=spf1 -all"),
    ],
)
def test_record_data_is_validated_per_type(record_type, data, expected):
    assert dns.validate_data(record_type, data) == expected


@pytest.mark.parametrize(
    ("record_type", "data"),
    [
        ("A", "not-an-ip"),
        ("A", "10.0.0.10; rm -rf /"),
        ("AAAA", "10.0.0.10"),
        ("CNAME", "host name.example"),
        ("MX", "mail.example"),  # missing preference
        ("MX", "-1 mail.example"),
        ("SRV", "0 100 dc1.example"),  # missing a field
        ("TXT", 'has a "quote"'),
        ("TXT", "x" * 600),
    ],
)
def test_malformed_record_data_is_refused(record_type, data):
    with pytest.raises(dns.DnsError):
        dns.validate_data(record_type, data)


def test_record_listing_parses_samba_tool_output(monkeypatch):
    output = """  Name=, Records=2, Children=1
    SOA: serial=110, refresh=900 (flags=600000f0, serial=110, ttl=3600)
    NS: dc1.corp.example.internal. (flags=600000f0, serial=1, ttl=900)
  Name=dc1, Records=1, Children=0
    A: 10.0.0.10 (flags=f0, serial=1, ttl=900)
"""
    monkeypatch.setattr(dns, "_run", lambda settings, *args: output)
    records = dns.list_records(get_settings(), "corp.example.internal")

    assert [(r.name, r.type, r.data, r.ttl) for r in records] == [
        ("@", "SOA", "serial=110, refresh=900", 3600),
        ("@", "NS", "dc1.corp.example.internal.", 900),
        ("dc1", "A", "10.0.0.10", 900),
    ]


def test_dns_reports_unavailable_rather_than_crashing(monkeypatch):
    monkeypatch.setattr(dns, "available", lambda: False)
    with pytest.raises(dns.DnsUnavailable):
        dns._run(get_settings(), "zonelist", "dc1")


# -------------------------------------------------------------------- DHCP ---


def test_scope_validation_normalises_and_bounds():
    scope = kea.validate_scope(
        {
            "subnet": "10.10.0.0/24",
            "pools": [{"pool": "10.10.0.100 - 10.10.0.200"}],
            "option-data": [{"name": "domain-name-servers", "data": "10.10.0.1"}],
            "valid-lifetime": 3600,
            "comment": "Sales floor",
        }
    )
    assert scope["subnet"] == "10.10.0.0/24"
    assert scope["pools"] == [{"pool": "10.10.0.100 - 10.10.0.200"}]
    assert scope["user-context"] == {"comment": "Sales floor"}


@pytest.mark.parametrize(
    "scope",
    [
        {"subnet": "not-a-subnet"},
        {},
        # A pool outside its own subnet hands out addresses that never route.
        {"subnet": "10.10.0.0/24", "pools": [{"pool": "192.168.1.10 - 192.168.1.20"}]},
        {"subnet": "10.10.0.0/24", "pools": [{"pool": "10.10.0.200 - 10.10.0.100"}]},
        {"subnet": "10.10.0.0/24", "pools": [{"pool": "garbage"}]},
        {"subnet": "10.10.0.0/24", "option-data": [{"name": "bad name!", "data": "x"}]},
    ],
)
def test_bad_scopes_never_reach_kea(scope):
    with pytest.raises(kea.KeaError):
        kea.validate_scope(scope)


def test_reservation_validation():
    reservation = kea.validate_reservation(
        {"hw-address": "00:11:22:AA:BB:CC", "ip-address": "10.10.0.50", "hostname": "ws01"}
    )
    assert reservation == {
        "hw-address": "00:11:22:aa:bb:cc",
        "ip-address": "10.10.0.50",
        "hostname": "ws01",
    }


@pytest.mark.parametrize(
    "reservation",
    [
        {"hw-address": "not-a-mac", "ip-address": "10.10.0.50"},
        {"hw-address": "00:11:22:aa:bb:cc", "ip-address": "999.0.0.1"},
        {"hw-address": "00:11:22:aa:bb:cc"},
        {"hw-address": "00:11:22:aa:bb:cc", "ip-address": "10.0.0.1", "hostname": "bad host"},
    ],
)
def test_bad_reservations_are_refused(reservation):
    with pytest.raises(kea.KeaError):
        kea.validate_reservation(reservation)


def test_dhcp_reports_unconfigured_rather_than_failing_obscurely():
    settings = get_settings()
    assert kea.configured(settings) is False
    with pytest.raises(kea.KeaUnavailable):
        kea.command(settings, "config-get")


def test_kea_url_must_be_https_off_the_loopback(monkeypatch):
    from odm.config import Settings

    for url in ("http://dhcp1.corp.example.internal:8000/", "ftp://x"):
        with pytest.raises(ValueError):
            Settings(
                realm="corp.example.internal",
                domain="corp.example.internal",
                ldap_uri="ldaps://dc1",
                ldap_ca_cert="/nonexistent",
                database_url="postgresql://odm@localhost/odm",
                kea_url=url,
            )
    for url in ("https://dhcp1.corp.example.internal:8000/", "http://127.0.0.1:8000/"):
        assert Settings(
            realm="corp.example.internal",
            domain="corp.example.internal",
            ldap_uri="ldaps://dc1",
            ldap_ca_cert="/nonexistent",
            database_url="postgresql://odm@localhost/odm",
            kea_url=url,
        ).kea_url == url


# ------------------------------------------------------- samba-tool errors --


def test_a_traceback_reports_the_exception_not_the_marker_under_it():
    """samba-tool fails by letting a traceback out.

    Taking its last line — the obvious thing — gives the ~~~^^^ marker Python
    draws under the failing expression, which is what the console showed in
    place of the error.
    """
    from odm.dns import message

    traceback = (
        "Traceback (most recent call last):\n"
        '  File "/usr/bin/samba-tool", line 39, in <module>\n'
        '    cmd._run("samba-tool", *args)\n'
        "    ~~~~~~~~^^^^^^^^^^^^^^^^^^^^^\n"
        "ldb.LdbError: (50, 'insufficient access rights during LDB_MODIFY')\n"
        "        ~~~~~~~~^^^^^^^^^^^^^^^^^^\n"
    )
    assert message(traceback, "", "fallback") == (
        "ldb.LdbError: (50, 'insufficient access rights during LDB_MODIFY')"
    )


def test_an_error_line_survives_and_silence_falls_back():
    from odm.dns import message

    assert message("ERROR(runtime): no such zone\n", "", "fb") == "ERROR(runtime): no such zone"
    assert message("", "", "fb") == "fb"
    assert message("", "  indented only\n", "fb") == "fb"


# -------------------------------------------------------------- Kea leases --


def test_all_leases_are_asked_for_without_a_subnet_filter(monkeypatch):
    """{"subnets": []} is not "every subnet" — it is "these zero subnets".

    Kea answers it with no leases at all, so the console showed an empty
    Leases tab under a scope whose utilisation said an address was in use.
    """
    sent: dict[str, object] = {}

    def fake_command(settings, name, arguments=None, service="dhcp4"):
        sent["name"] = name
        sent["arguments"] = arguments
        return {"leases": [{"ip-address": "10.10.0.50"}]}

    monkeypatch.setattr(kea, "command", fake_command)
    leases = kea.leases(get_settings())

    assert sent["name"] == "lease4-get-all"
    assert sent["arguments"] is None
    assert leases == [{"ip-address": "10.10.0.50"}]
