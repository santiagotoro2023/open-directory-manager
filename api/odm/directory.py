"""LDAP access to the Samba AD DC.

This is the only module that speaks LDAP. It verifies credentials with a
bind, and answers who a principal is: the groups it belongs to, including
through nesting, and whether one of them is the Domain-Admins-equivalent
group the console is gated on.

All binds are LDAPS with certificate validation against the DC's CA
(CLAUDE.md §6 — no plaintext LDAP, no custom crypto).
"""

from __future__ import annotations

import re
import ssl
from dataclasses import dataclass, replace

from ldap3 import KERBEROS, SASL, SIMPLE, SUBTREE, Connection, Server, Tls
from ldap3.protocol.formatters.formatters import format_sid
from ldap3.utils.conv import escape_filter_chars

from .config import Settings

# LDAP_MATCHING_RULE_IN_CHAIN — walks nested group membership server-side.
MATCHING_RULE_IN_CHAIN = "1.2.840.113556.1.4.1941"
UF_ACCOUNTDISABLE = 0x0002
UF_LOCKOUT = 0x0010

# sAMAccountName charset, minus the characters AD forbids. Validated before a
# name ever reaches a filter; escaping is applied on top of this.
_USERNAME_RE = re.compile(r"^[A-Za-z0-9._\- ]{1,104}$")


class DirectoryError(Exception):
    """LDAP transport or configuration failure."""


class InvalidCredentials(Exception):
    """Bind rejected by the DC."""


class NotAuthorized(Exception):
    """Authenticated, but not a member of the required group."""


@dataclass(frozen=True)
class DirectoryUser:
    dn: str
    sam_account_name: str
    user_principal_name: str
    display_name: str
    sid: str | None
    # Every group the account is in, nesting included. Delegated-administration
    # assignments are matched against these.
    group_sids: tuple[str, ...] = ()
    group_dns: tuple[str, ...] = ()
    is_domain_admin: bool = False


def read_sid(value: object) -> str | None:
    """objectSid comes back as a binary blob; ldap3 knows how to render it."""
    if value is None:
        return None
    if isinstance(value, bytes):
        formatted = format_sid(value)
        return str(formatted) if formatted else None
    text = str(value)
    return text or None


def validate_username(username: str) -> str:
    """Normalise a logon name, or reject what is not one.

    All three spellings a person may be given are accepted: the bare
    sAMAccountName, the user principal name, and DOMAIN\\name — which is what
    the GNOME greeter itself suggests, and what the display manager then hands
    to the agent. Rejecting it made the whole logon-time policy fail with a
    500 for somebody who had signed in perfectly well.
    """
    candidate = username.strip()
    if not candidate:
        raise InvalidCredentials("empty username")
    domain_prefix, sep, rest = candidate.partition("\\")
    if sep:
        if not re.match(r"^[A-Za-z0-9.\-]{1,253}$", domain_prefix):
            raise InvalidCredentials("invalid username")
        candidate = rest
    local, sep, domain = candidate.partition("@")
    if not _USERNAME_RE.match(local):
        raise InvalidCredentials("invalid username")
    if sep and not re.match(r"^[A-Za-z0-9.\-]{1,253}$", domain):
        raise InvalidCredentials("invalid username")
    return candidate


def to_upn(username: str, realm: str) -> str:
    """Bare name -> user@REALM; an explicit UPN is left alone."""
    return username if "@" in username else f"{username}@{realm}"


def nested_groups_filter(dn: str) -> str:
    """Every group containing dn, walked server-side through nesting."""
    return (
        "(&(objectClass=group)"
        f"(member:{MATCHING_RULE_IN_CHAIN}:={escape_filter_chars(dn)}))"
    )


def _tls(settings: Settings) -> Tls:
    return Tls(
        ca_certs_file=str(settings.ldap_ca_cert),
        validate=ssl.CERT_REQUIRED,
        version=ssl.PROTOCOL_TLS_CLIENT,
    )


def _connect(settings: Settings, user: str, password: str) -> Connection:
    server = Server(
        settings.ldap_uri,
        tls=_tls(settings),
        connect_timeout=settings.ldap_timeout_seconds,
    )
    conn = Connection(
        server,
        user=user,
        password=password,
        authentication=SIMPLE,
        read_only=True,
        raise_exceptions=False,
        receive_timeout=settings.ldap_timeout_seconds,
    )
    try:
        bound = conn.bind()
    except Exception as exc:  # ldap3 wraps socket/TLS failures
        raise DirectoryError(f"cannot reach {settings.ldap_uri}: {exc}") from exc
    if not bound:
        raise InvalidCredentials(conn.result.get("description", "invalid credentials"))
    return conn


def authenticate(settings: Settings, username: str, password: str) -> DirectoryUser:
    """Bind as the user and resolve who they are.

    Membership of the admin group is reported rather than required: whether a
    session is issued is decided above, so a delegated administrator with a
    scoped assignment can sign in without being a domain admin.

    Blocking; call through run_in_threadpool.
    """
    username = validate_username(username)
    if not password:
        # An empty password would be an LDAP *unauthenticated* bind, which
        # succeeds. Never let one reach the DC.
        raise InvalidCredentials("empty password")

    # Resolve the account to its distinguished name before binding as it.
    #
    # A simple bind matches the name it is handed literally, and which forms
    # of a name exist varies by account: a freshly provisioned Samba
    # Administrator has no userPrincipalName, so Administrator@REALM matches
    # nothing and the bind is refused exactly as though the password were
    # wrong. A distinguished name always exists, so one bind attempt settles
    # it — which also means a mistyped password costs the account one failure
    # here and not several.
    service = service_connection(settings)
    try:
        found = _lookup_user(settings, service, to_upn(username, settings.realm), username)
    finally:
        service.unbind()

    conn = _connect(settings, found.dn, password)
    try:
        return _describe(settings, conn, found)
    finally:
        conn.unbind()


def service_connection(settings: Settings, *, read_only: bool = True) -> Connection:
    """Read-only SASL/GSSAPI bind as ODM's own service principal.

    Initiator credentials come from the keytab named by KRB5_CLIENT_KTNAME
    (set at startup from settings.keytab). This account needs nothing beyond
    the directory read rights every authenticated principal already has —
    never a Domain Admin bind for routine reads (CLAUDE.md §6).

    The principal is named explicitly. Left to itself the library takes the
    first entry in the keytab, which is the HTTP service principal it also
    holds for accepting browser tickets — and Active Directory issues a
    ticket-granting ticket to an account, never to one of its service
    principal names, so that attempt is refused as an unknown client.
    """
    server = Server(
        settings.ldap_uri,
        tls=_tls(settings),
        connect_timeout=settings.ldap_timeout_seconds,
    )
    conn = Connection(
        server,
        user=f"{settings.service_account}@{settings.realm}",
        authentication=SASL,
        sasl_mechanism=KERBEROS,
        read_only=read_only,
        raise_exceptions=False,
        receive_timeout=settings.ldap_timeout_seconds,
    )
    try:
        bound = conn.bind()
    except Exception as exc:
        raise DirectoryError(f"GSSAPI bind to {settings.ldap_uri} failed: {exc}") from exc
    if not bound:
        raise DirectoryError(conn.result.get("description", "GSSAPI bind rejected"))
    return conn


def authorize_principal(settings: Settings, upn: str) -> DirectoryUser:
    """Resolve an already-authenticated Kerberos principal.

    Used by the SPNEGO path, where no password ever reaches ODM, and by the
    periodic re-check that keeps a live session honest.
    Blocking; call through run_in_threadpool.
    """
    validate_username(upn)
    conn = service_connection(settings)
    try:
        return _describe(settings, conn, _lookup_user(settings, conn, upn, upn.partition("@")[0]))
    finally:
        conn.unbind()


def _describe(settings: Settings, conn: Connection, user: DirectoryUser) -> DirectoryUser:
    """Fill in group membership and the domain-admin flag."""
    groups = nested_groups(conn, settings, user.dn)
    admin = settings.admin_group.lower()
    return replace(
        user,
        group_dns=tuple(group["dn"] for group in groups),
        group_sids=tuple(group["sid"] for group in groups if group["sid"]),
        is_domain_admin=any(
            str(group.get("sam_account_name", "")).lower() == admin for group in groups
        ),
    )


def _search(conn: Connection, base: str, filt: str, attributes: list[str]) -> list[dict]:
    ok = conn.search(
        search_base=base,
        search_filter=filt,
        search_scope=SUBTREE,
        attributes=attributes,
    )
    if not ok:
        raise DirectoryError(conn.result.get("description", "ldap search failed"))
    return [e for e in conn.response if e.get("type") == "searchResEntry"]


def _lookup_user(
    settings: Settings, conn: Connection, upn: str, username: str
) -> DirectoryUser:
    sam = username.partition("@")[0]
    filt = (
        "(&(objectCategory=person)(objectClass=user)"
        f"(|(userPrincipalName={escape_filter_chars(upn)})"
        f"(sAMAccountName={escape_filter_chars(sam)})))"
    )
    entries = _search(
        conn,
        settings.base_dn,
        filt,
        ["distinguishedName", "sAMAccountName", "userPrincipalName", "displayName",
         "userAccountControl", "objectSid"],
    )
    if len(entries) != 1:
        # 0 = gone between bind and search; >1 = ambiguous, never guess in an
        # identity system.
        raise NotAuthorized("account could not be resolved unambiguously")

    attrs = entries[0]["attributes"]
    uac = int(attrs.get("userAccountControl") or 0)
    if uac & (UF_ACCOUNTDISABLE | UF_LOCKOUT):
        raise NotAuthorized("account disabled or locked out")

    dn = entries[0]["dn"]
    return DirectoryUser(
        dn=dn,
        sam_account_name=str(attrs.get("sAMAccountName") or sam),
        user_principal_name=str(attrs.get("userPrincipalName") or upn),
        display_name=str(attrs.get("displayName") or attrs.get("sAMAccountName") or sam),
        sid=read_sid(attrs.get("objectSid")),
    )


def netbios_name(conn: Connection, settings: Settings) -> str:
    """The domain's short name, e.g. EXAMPLE for corp.example.internal.

    Read from the domain's crossRef rather than configured a second time, so it
    cannot drift from what the directory actually calls itself.

    Blocking; call through run_in_threadpool.
    """
    entries = _search(
        conn,
        f"CN=Partitions,CN=Configuration,{settings.base_dn}",
        f"(&(objectClass=crossRef)(nCName={escape_filter_chars(settings.base_dn)}))",
        ["nETBIOSName"],
    )
    if not entries:
        return ""
    return str(entries[0]["attributes"].get("nETBIOSName") or "")


def nested_groups(conn: Connection, settings: Settings, dn: str) -> list[dict[str, str | None]]:
    """Every group the object belongs to, including through nesting.

    Blocking; call through run_in_threadpool.
    """
    entries = _search(
        conn,
        settings.base_dn,
        nested_groups_filter(dn),
        ["distinguishedName", "sAMAccountName", "objectSid"],
    )
    return [
        {
            "dn": entry["dn"],
            "sam_account_name": str(entry["attributes"].get("sAMAccountName") or ""),
            "sid": read_sid(entry["attributes"].get("objectSid")),
        }
        for entry in entries
    ]
