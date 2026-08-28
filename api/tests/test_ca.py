"""Phase 8: the certificate authority."""

from __future__ import annotations

import datetime as dt

import pytest
from conftest import BASE_DN  # noqa: F401  (environment setup ordering)
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.x509.oid import ExtendedKeyUsageOID

from odm import ca
from odm.config import Settings


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        realm="corp.example.internal",
        domain="corp.example.internal",
        ldap_uri="ldaps://dc1.corp.example.internal",
        ldap_ca_cert="/nonexistent/ca.pem",
        database_url="postgresql://odm@localhost/odm",
        ca_dir=tmp_path / "ca",
    )


@pytest.fixture
def initialised(settings) -> Settings:
    ca.initialise(settings)
    return settings


def parse(pem: str) -> x509.Certificate:
    return x509.load_pem_x509_certificate(pem.encode())


# ---------------------------------------------------------------- the root ---


def test_root_is_a_constrained_ca_with_a_protected_key(settings):
    pem = ca.initialise(settings)
    certificate = parse(pem)

    constraints = certificate.extensions.get_extension_for_class(x509.BasicConstraints).value
    assert constraints.ca is True
    # No subordinate CAs: this root signs leaves only.
    assert constraints.path_length == 0

    usage = certificate.extensions.get_extension_for_class(x509.KeyUsage).value
    assert usage.key_cert_sign and usage.crl_sign
    assert not usage.key_encipherment

    assert (ca.key_path(settings).stat().st_mode & 0o777) == 0o600


def test_initialising_twice_is_refused(initialised):
    with pytest.raises(ca.CaError):
        ca.initialise(initialised)


def test_operations_before_initialisation_say_so(settings):
    assert ca.initialised(settings) is False
    assert ca.describe(settings) == {"initialised": False}
    with pytest.raises(ca.CaNotInitialised):
        ca.root_pem(settings)
    with pytest.raises(ca.CaNotInitialised):
        ca.issue(settings, common_name="host.corp.example.internal")


def test_an_unconfigured_role_is_not_an_error(tmp_path):
    unset = Settings(
        realm="corp.example.internal",
        domain="corp.example.internal",
        ldap_uri="ldaps://dc1",
        ldap_ca_cert="/nonexistent",
        database_url="postgresql://odm@localhost/odm",
    )
    assert ca.initialised(unset) is False


# ------------------------------------------------------------------ issuing ---


def test_server_certificate_carries_its_names_and_purpose(initialised):
    issued = ca.issue(
        initialised,
        common_name="fs01.corp.example.internal",
        sans=["files.corp.example.internal", "10.10.0.20"],
    )
    certificate = parse(issued.certificate_pem)

    names = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert "fs01.corp.example.internal" in names.get_values_for_type(x509.DNSName)
    assert "files.corp.example.internal" in names.get_values_for_type(x509.DNSName)
    assert str(names.get_values_for_type(x509.IPAddress)[0]) == "10.10.0.20"

    purpose = certificate.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    assert ExtendedKeyUsageOID.SERVER_AUTH in purpose
    assert certificate.extensions.get_extension_for_class(x509.BasicConstraints).value.ca is False


def test_client_profile_is_for_authentication_not_serving(initialised):
    issued = ca.issue(initialised, common_name="ada", profile="client")
    purpose = parse(issued.certificate_pem).extensions.get_extension_for_class(
        x509.ExtendedKeyUsage
    ).value
    assert ExtendedKeyUsageOID.CLIENT_AUTH in purpose
    assert ExtendedKeyUsageOID.SERVER_AUTH not in purpose


def test_certificates_chain_to_the_root(initialised):
    root = parse(ca.root_pem(initialised))
    leaf = parse(ca.issue(initialised, common_name="fs01.corp.example.internal").certificate_pem)
    assert leaf.issuer == root.subject
    # Signed by the root's key, not merely claiming to be.
    root.public_key().verify(
        leaf.signature,
        leaf.tbs_certificate_bytes,
        padding.PKCS1v15(),
        leaf.signature_hash_algorithm,
    )


def test_validity_is_bounded(initialised):
    issued = ca.issue(initialised, common_name="fs01.corp.example.internal", validity_days=30)
    certificate = parse(issued.certificate_pem)
    lifetime = certificate.not_valid_after_utc - certificate.not_valid_before_utc
    assert dt.timedelta(days=29) < lifetime < dt.timedelta(days=31)

    for bad in (0, -1, ca.MAX_VALIDITY_DAYS + 1):
        with pytest.raises(ca.CaError):
            ca.issue(initialised, common_name="fs01.corp.example.internal", validity_days=bad)


def test_unknown_profiles_and_hostile_names_are_refused(initialised):
    with pytest.raises(ca.CaError):
        ca.issue(initialised, common_name="fs01.corp.example.internal", profile="root")
    for name in ("", "not a host", "host;reboot", "-leading", "a" * 300):
        with pytest.raises(ca.CaError):
            ca.issue(initialised, common_name=name)


def test_every_certificate_gets_its_own_serial_and_key(initialised):
    first = ca.issue(initialised, common_name="fs01.corp.example.internal")
    second = ca.issue(initialised, common_name="fs01.corp.example.internal")
    assert first.serial != second.serial
    assert first.private_key_pem != second.private_key_pem


def test_fingerprint_matches_the_certificate(initialised):
    issued = ca.issue(initialised, common_name="fs01.corp.example.internal")
    expected = parse(issued.certificate_pem).fingerprint(hashes.SHA256()).hex(":")
    assert issued.fingerprint == expected


# ---------------------------------------------------------------------- CRL ---


def test_revocation_list_names_the_revoked_serials(initialised):
    issued = ca.issue(initialised, common_name="fs01.corp.example.internal")
    pem = ca.build_crl(initialised, [(issued.serial, dt.datetime.now(dt.UTC))])

    crl = x509.load_pem_x509_crl(pem.encode())
    assert crl.issuer == parse(ca.root_pem(initialised)).subject
    assert [entry.serial_number for entry in crl] == [int(issued.serial, 16)]


def test_an_empty_revocation_list_is_still_valid(initialised):
    crl = x509.load_pem_x509_crl(ca.build_crl(initialised, []).encode())
    assert len(list(crl)) == 0
