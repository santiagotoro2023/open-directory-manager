"""Trust anchors: what a pasted certificate is read as, and what is refused."""

from __future__ import annotations

import datetime as dt

import conftest  # noqa: F401  (environment setup ordering)
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from odm import ca


def certificate(common_name: str = "Example Root CA", *, is_ca: bool = True) -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    now = dt.datetime.now(dt.UTC)
    builder = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=1))
        .not_valid_after(now + dt.timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=is_ca, path_length=None), critical=True)
    )
    signed = builder.sign(key, hashes.SHA256())
    return signed.public_bytes(serialization.Encoding.PEM).decode("ascii")


def test_a_certificate_authority_is_recognised_as_one():
    described = ca.inspect_pem(certificate("Example Root CA", is_ca=True))

    assert described["is_ca"] is True
    assert "Example Root CA" in described["subject"]
    assert described["not_after"] > described["not_before"]


def test_a_leaf_certificate_is_not_reported_as_an_authority():
    """Trusting a leaf is legitimate; calling it an authority is not."""
    assert ca.inspect_pem(certificate("service.example.internal", is_ca=False))["is_ca"] is False


def test_the_fingerprint_is_the_sha256_of_the_certificate():
    pem = certificate()
    expected = x509.load_pem_x509_certificate(pem.encode()).fingerprint(hashes.SHA256())

    assert ca.inspect_pem(pem)["fingerprint"] == expected.hex(":")


@pytest.mark.parametrize(
    "body",
    [
        "",
        "not a certificate",
        "-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----",
        "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
    ],
)
def test_anything_that_is_not_a_pem_certificate_is_refused(body):
    """It is parsed at the boundary, so what is stored is known to be one."""
    with pytest.raises(ca.CaError):
        ca.inspect_pem(body)
