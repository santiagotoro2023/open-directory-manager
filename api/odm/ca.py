"""Certificate authority.

ODM issues an internal CA and the certificates the domain needs from it:
server certificates for member machines, client certificates for
authentication, and the certificate the administration console itself is
served with. Trust is distributed to domain members through Group Policy.

Key material is generated and signed with the `cryptography` library, and
private keys are written 0600 into the CA directory (CLAUDE.md §6).
"""

from __future__ import annotations

import datetime as dt
import ipaddress
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from .config import Settings

KEY_SIZE = 4096
LEAF_KEY_SIZE = 2048
CA_VALIDITY_DAYS = 3650
DEFAULT_VALIDITY_DAYS = 397  # the longest a public CA may issue; a sane ceiling here too
MAX_VALIDITY_DAYS = 1825

HOST_RE = re.compile(
    r"^(?=.{1,253}$)[A-Za-z0-9_*]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?"
    r"(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?)*$"
)

PROFILES = ("server", "client", "console")

# What a certificate may be used for. The names are ODM's; the OIDs are the
# ones the standard defines, taken from the library rather than written out.
PURPOSES: dict[str, Any] = {
    "server": ExtendedKeyUsageOID.SERVER_AUTH,
    "client": ExtendedKeyUsageOID.CLIENT_AUTH,
    "email": ExtendedKeyUsageOID.EMAIL_PROTECTION,
    "code-signing": ExtendedKeyUsageOID.CODE_SIGNING,
    "timestamping": ExtendedKeyUsageOID.TIME_STAMPING,
    "ocsp-signing": ExtendedKeyUsageOID.OCSP_SIGNING,
    "smartcard-logon": x509.ObjectIdentifier("1.3.6.1.4.1.311.20.2.2"),
    "kerberos-pkinit": x509.ObjectIdentifier("1.3.6.1.5.2.3.5"),
}

# What the two built-in profiles mean, so a custom profile and a built-in one
# go through exactly the same code below.
BUILT_IN_PURPOSES: dict[str, tuple[str, ...]] = {
    "server": ("server",),
    "console": ("server",),
    "client": ("client",),
}


class CaError(Exception):
    """The certificate authority refused the request."""


class CaNotInitialised(CaError):
    """No CA has been created yet."""


@dataclass(frozen=True)
class Issued:
    serial: str
    subject: str
    sans: list[str]
    profile: str
    not_before: dt.datetime
    not_after: dt.datetime
    fingerprint: str
    certificate_pem: str
    private_key_pem: str | None


def ca_dir(settings: Settings) -> Path:
    if settings.ca_dir is None:
        raise CaNotInitialised("the certificate authority role is not configured")
    return Path(settings.ca_dir)


def key_path(settings: Settings) -> Path:
    return ca_dir(settings) / "ca-key.pem"


def cert_path(settings: Settings) -> Path:
    return ca_dir(settings) / "ca-cert.pem"


def initialised(settings: Settings) -> bool:
    try:
        return key_path(settings).exists() and cert_path(settings).exists()
    except CaNotInitialised:
        return False


def validate_name(name: str) -> str:
    name = name.strip().lower().rstrip(".")
    if not HOST_RE.match(name):
        raise CaError(f"invalid name {name!r}")
    return name


def _write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    path.write_bytes(data)


def initialise(settings: Settings, common_name: str | None = None) -> str:
    """Create the root CA. Refuses to overwrite one that already exists."""
    if initialised(settings):
        raise CaError("a certificate authority already exists here")

    subject_name = common_name or f"{settings.domain} Open Directory Manager CA"
    key = rsa.generate_private_key(public_exponent=65537, key_size=KEY_SIZE)
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, subject_name[:64]),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, settings.domain[:64]),
        ]
    )
    now = dt.datetime.now(dt.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=CA_VALIDITY_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False
        )
        .sign(key, hashes.SHA256())
    )

    _write_private(
        key_path(settings),
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ),
    )
    cert_path(settings).write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    cert_path(settings).chmod(0o644)
    return root_pem(settings)


def _load(settings: Settings) -> tuple[Any, x509.Certificate]:
    if not initialised(settings):
        raise CaNotInitialised("no certificate authority has been created yet")
    key = serialization.load_pem_private_key(key_path(settings).read_bytes(), password=None)
    certificate = x509.load_pem_x509_certificate(cert_path(settings).read_bytes())
    return key, certificate


def root_pem(settings: Settings) -> str:
    if not initialised(settings):
        raise CaNotInitialised("no certificate authority has been created yet")
    return cert_path(settings).read_text(encoding="ascii")


def describe(settings: Settings) -> dict[str, Any]:
    if not initialised(settings):
        return {"initialised": False}
    _, certificate = _load(settings)
    return {
        "initialised": True,
        "subject": certificate.subject.rfc4514_string(),
        "not_before": certificate.not_valid_before_utc,
        "not_after": certificate.not_valid_after_utc,
        "fingerprint": certificate.fingerprint(hashes.SHA256()).hex(":"),
        "serial": format(certificate.serial_number, "x"),
    }


def _san(names: list[str]) -> x509.SubjectAlternativeName:
    entries: list[x509.GeneralName] = []
    for name in names:
        try:
            entries.append(x509.IPAddress(ipaddress.ip_address(name)))
            continue
        except ValueError:
            pass
        entries.append(x509.DNSName(validate_name(name)))
    return x509.SubjectAlternativeName(entries)


def issue(
    settings: Settings,
    *,
    common_name: str,
    sans: list[str] | None = None,
    profile: str = "server",
    validity_days: int = DEFAULT_VALIDITY_DAYS,
    purposes: Sequence[str] | None = None,
    key_size: int = LEAF_KEY_SIZE,
    public_key: Any = None,
) -> Issued:
    """Issue a leaf certificate with a freshly generated key — or, given a
    public key from somebody else's signing request, for that key, in which
    case no private key is ever here to hand back.

    purposes overrides what the profile name would have meant, which is how a
    profile an operator defined is issued from: the name is still recorded, so
    the issued list says which profile a certificate came from.
    """
    if purposes is None:
        if profile not in PROFILES:
            raise CaError(f"unknown certificate profile {profile!r}")
        purposes = BUILT_IN_PURPOSES[profile]
    unknown = [name for name in purposes if name not in PURPOSES]
    if unknown or not purposes:
        raise CaError(f"unknown certificate purpose {unknown[0]!r}" if unknown else "no purpose")
    if key_size not in (2048, 3072, 4096):
        raise CaError(f"unsupported key size {key_size}")
    if not 1 <= validity_days <= MAX_VALIDITY_DAYS:
        raise CaError(f"validity must be between 1 and {MAX_VALIDITY_DAYS} days")

    common_name = validate_name(common_name)
    all_names = [common_name, *[n for n in (sans or []) if n]]

    ca_key, ca_cert = _load(settings)
    key = None if public_key is not None else rsa.generate_private_key(
        public_exponent=65537, key_size=key_size
    )
    subject_key = public_key if public_key is not None else key.public_key()
    now = dt.datetime.now(dt.UTC)

    usage = [PURPOSES[name] for name in purposes]
    builder = (
        x509.CertificateBuilder()
        .subject_name(
            x509.Name(
                [
                    x509.NameAttribute(NameOID.COMMON_NAME, common_name[:64]),
                    x509.NameAttribute(NameOID.ORGANIZATION_NAME, settings.domain[:64]),
                ]
            )
        )
        .issuer_name(ca_cert.subject)
        .public_key(subject_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=validity_days))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(_san(all_names), critical=False)
        .add_extension(x509.ExtendedKeyUsage(usage), critical=False)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        # Where to find out whether this certificate has been withdrawn.
        # Without it a revocation is bookkeeping: nothing checking the
        # certificate has any way to learn about it, and the certificate keeps
        # working until it expires.
        .add_extension(crl_distribution_points(settings), critical=False)
    )
    certificate = builder.sign(ca_key, hashes.SHA256())

    return Issued(
        serial=format(certificate.serial_number, "x"),
        subject=common_name,
        sans=all_names,
        profile=profile,
        not_before=certificate.not_valid_before_utc,
        not_after=certificate.not_valid_after_utc,
        fingerprint=certificate.fingerprint(hashes.SHA256()).hex(":"),
        certificate_pem=certificate.public_bytes(serialization.Encoding.PEM).decode("ascii"),
        private_key_pem=key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii")
        if key is not None
        else None,
    )


# Where the list of withdrawn certificates is published. A fixed path on the
# console, served without authentication: a client checking a certificate has
# no session and cannot be asked for one.
CRL_PATH = "/crl/odm.crl"


def crl_url(settings: Settings) -> str:
    return f"{settings.console_url}{CRL_PATH}"


def crl_distribution_points(settings: Settings) -> x509.CRLDistributionPoints:
    return x509.CRLDistributionPoints(
        [
            x509.DistributionPoint(
                full_name=[x509.UniformResourceIdentifier(crl_url(settings))],
                relative_name=None,
                reasons=None,
                crl_issuer=None,
            )
        ]
    )


def build_crl(settings: Settings, revoked: list[tuple[str, dt.datetime]]) -> str:
    """Certificate revocation list covering the serials handed in."""
    ca_key, ca_cert = _load(settings)
    now = dt.datetime.now(dt.UTC)
    builder = (
        x509.CertificateRevocationListBuilder()
        .issuer_name(ca_cert.subject)
        .last_update(now)
        .next_update(now + dt.timedelta(days=7))
    )
    for serial, when in revoked:
        builder = builder.add_revoked_certificate(
            x509.RevokedCertificateBuilder()
            .serial_number(int(serial, 16))
            .revocation_date(when)
            .build()
        )
    return builder.sign(ca_key, hashes.SHA256()).public_bytes(
        serialization.Encoding.PEM
    ).decode("ascii")


def crl_der(settings: Settings, revoked: list[tuple[str, dt.datetime]]) -> bytes:
    """The same list in the encoding clients actually fetch."""
    ca_key, ca_cert = _load(settings)
    now = dt.datetime.now(dt.UTC)
    builder = (
        x509.CertificateRevocationListBuilder()
        .issuer_name(ca_cert.subject)
        .last_update(now)
        .next_update(now + dt.timedelta(days=7))
    )
    for serial, when in revoked:
        builder = builder.add_revoked_certificate(
            x509.RevokedCertificateBuilder()
            .serial_number(int(serial, 16))
            .revocation_date(when)
            .build()
        )
    return builder.sign(ca_key, hashes.SHA256()).public_bytes(serialization.Encoding.DER)


# ------------------------------------------------------------ trust anchors ---
# Certificates the domain should trust that ODM did not issue: an existing
# internal CA, a vendor appliance, the authority in front of some service.
# Distributing them uses the same policy setting as ODM's own root; what is
# added here is somewhere to keep them and a description of what each one is.


def inspect_pem(certificate_pem: str) -> dict[str, Any]:
    """Read a PEM certificate well enough to show what it is.

    Parsing here rather than in the console means a paste that is not a
    certificate is refused at the boundary, and the operator sees which
    authority and which dates they are about to trust before they trust it.
    """
    try:
        certificate = x509.load_pem_x509_certificate(certificate_pem.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as exc:
        raise CaError("that is not a PEM certificate") from exc

    try:
        basic = certificate.extensions.get_extension_for_class(x509.BasicConstraints)
        is_ca = bool(basic.value.ca)
    except x509.ExtensionNotFound:
        is_ca = False

    return {
        "subject": certificate.subject.rfc4514_string(),
        "issuer": certificate.issuer.rfc4514_string(),
        "fingerprint": certificate.fingerprint(hashes.SHA256()).hex(":"),
        "not_before": certificate.not_valid_before_utc,
        "not_after": certificate.not_valid_after_utc,
        "is_ca": is_ca,
    }


# ------------------------------------------------------- foreign material ----
# Certificates that did not start here: a request somebody else will sign, a
# request somebody else made for this authority to sign, and a certificate
# and key an operator brings from wherever they got them.


def _names_of(certificate_or_request: Any) -> list[str]:
    """Common name and every subject alternative name, as plain strings."""
    names: list[str] = []
    for attribute in certificate_or_request.subject.get_attributes_for_oid(NameOID.COMMON_NAME):
        names.append(str(attribute.value))
    try:
        san = certificate_or_request.extensions.get_extension_for_class(
            x509.SubjectAlternativeName
        ).value
    except x509.ExtensionNotFound:
        return names
    names.extend(str(name) for name in san.get_values_for_type(x509.DNSName))
    names.extend(str(name) for name in san.get_values_for_type(x509.IPAddress))
    # The common name is in the alternative names as well, by our own issue()
    # and by convention; once is enough.
    return list(dict.fromkeys(names))


def make_request(common_name: str, sans: list[str], organisation: str) -> tuple[str, str]:
    """A fresh private key and a signing request for it, both as PEM.

    For a certificate somebody else is going to sign — a public authority,
    a company one. The key stays on the console; only the request travels.
    """
    common_name = validate_name(common_name)
    all_names = [common_name, *[n for n in sans if n]]
    key = rsa.generate_private_key(public_exponent=65537, key_size=LEAF_KEY_SIZE)
    request = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(
            x509.Name(
                [
                    x509.NameAttribute(NameOID.COMMON_NAME, common_name[:64]),
                    x509.NameAttribute(NameOID.ORGANIZATION_NAME, organisation[:64]),
                ]
            )
        )
        .add_extension(_san(all_names), critical=False)
        .sign(key, hashes.SHA256())
    )
    return (
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii"),
        request.public_bytes(serialization.Encoding.PEM).decode("ascii"),
    )


def issue_from_request(
    settings: Settings,
    csr_pem: str,
    *,
    profile: str = "server",
    validity_days: int = DEFAULT_VALIDITY_DAYS,
    purposes: Sequence[str] | None = None,
) -> Issued:
    """Sign somebody else's request with this authority.

    The names come from the request; the extensions, the usage and the
    lifetime come from the profile, exactly as for a certificate issued
    here — a request is a public key with a name attached, not a say in
    what the certificate may be used for.
    """
    try:
        request = x509.load_pem_x509_csr(csr_pem.encode("ascii", "replace"))
    except (ValueError, TypeError) as exc:
        raise CaError(f"not a signing request: {exc}") from exc
    if not request.is_signature_valid:
        raise CaError("the request's own signature does not verify")
    names = _names_of(request)
    if not names:
        raise CaError("the request names nothing")
    return issue(
        settings,
        common_name=names[0],
        sans=names[1:],
        profile=profile,
        validity_days=validity_days,
        purposes=purposes,
        public_key=request.public_key(),
    )


def check_pair(certificate_pem: str, private_key_pem: str | None) -> dict[str, Any]:
    """Whether a certificate and a key belong together, and what the
    certificate is. The first PEM block is the leaf; anything after it is a
    chain and is kept with it."""
    try:
        blocks = x509.load_pem_x509_certificates(certificate_pem.encode("ascii", "replace"))
    except (ValueError, TypeError) as exc:
        raise CaError(f"not a certificate: {exc}") from exc
    if not blocks:
        raise CaError("no certificate in what was given")
    leaf = blocks[0]
    if private_key_pem:
        try:
            key = serialization.load_pem_private_key(
                private_key_pem.encode("ascii", "replace"), password=None
            )
        except (ValueError, TypeError) as exc:
            raise CaError(f"not a private key: {exc}") from exc
        expected = leaf.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        actual = key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        if expected != actual:
            raise CaError("that private key does not belong to that certificate")
    now = dt.datetime.now(dt.UTC)
    if leaf.not_valid_after_utc < now:
        raise CaError("that certificate has already expired")
    return {
        "names": _names_of(leaf),
        "not_after": leaf.not_valid_after_utc,
        "issuer": leaf.issuer.rfc4514_string(),
        "self_signed": leaf.issuer == leaf.subject,
        "chain": len(blocks) - 1,
    }


def is_self_signed(certificate_pem: str) -> bool:
    try:
        leaf = x509.load_pem_x509_certificate(certificate_pem.encode("ascii", "replace"))
    except (ValueError, TypeError):
        return False
    return leaf.issuer == leaf.subject


def issued_here(settings: Settings, certificate_pem: str) -> bool:
    """Whether this authority signed that certificate."""
    _key, root = _load(settings)
    leaf = x509.load_pem_x509_certificate(certificate_pem.encode("ascii", "replace"))
    return leaf.issuer == root.subject
