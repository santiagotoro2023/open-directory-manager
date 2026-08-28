"""LDAP access to the Samba AD DC.

This is the only module that speaks LDAP. It does two things in Phase 1:
verify a credential with a bind, and answer "is this principal a member of
the Domain-Admins-equivalent group, including through nested groups".

All binds are LDAPS with certificate validation against the DC's CA
(CLAUDE.md §6 — no plaintext LDAP, no custom crypto).
"""

from __future__ import annotations

import re
import ssl
from dataclasses import dataclass

from ldap3 import KERBEROS, SASL, SIMPLE, SUBTREE, Connection, Server, Tls
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


def validate_username(username: str) -> str:
    """Reject anything that is not a plain sAMAccountName or UPN."""
    candidate = username.strip()
    if not candidate:
        raise InvalidCredentials("empty username")
    local, sep, domain = candidate.partition("@")
    if not _USERNAME_RE.match(local):
        raise InvalidCredentials("invalid username")
    if sep and not re.match(r"^[A-Za-z0-9.\-]{1,253}$", domain):
        raise InvalidCredentials("invalid username")
    return candidate


def to_upn(username: str, realm: str) -> str:
    """Bare name -> user@REALM; an explicit UPN is left alone."""
    return username if "@" in username else f"{username}@{realm}"


def nested_member_filter(user_dn: str, group_dn: str) -> str:
    """Filter that matches user_dn only if it is in group_dn, nesting included."""
    return (
        "(&(objectClass=user)"
        f"(distinguishedName={escape_filter_chars(user_dn)})"
        f"(memberOf:{MATCHING_RULE_IN_CHAIN}:={escape_filter_chars(group_dn)}))"
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
    """Bind as the user, then require membership of settings.admin_group.

    Blocking; call through run_in_threadpool.
    """
    username = validate_username(username)
    if not password:
        # An empty password would be an LDAP *unauthenticated* bind, which
        # succeeds. Never let one reach the DC.
        raise InvalidCredentials("empty password")

    upn = to_upn(username, settings.realm)
    conn = _connect(settings, upn, password)
    try:
        user = _lookup_user(settings, conn, upn, username)
        group_dn = _lookup_group_dn(settings, conn, settings.admin_group)
        if not _is_member(settings, conn, user.dn, group_dn):
            raise NotAuthorized(f"not a member of {settings.admin_group}")
        return user
    finally:
        conn.unbind()


def service_connection(settings: Settings, *, read_only: bool = True) -> Connection:
    """Read-only SASL/GSSAPI bind as ODM's own service principal.

    Initiator credentials come from the keytab named by KRB5_CLIENT_KTNAME
    (set at startup from settings.keytab). This account needs nothing beyond
    the directory read rights every authenticated principal already has —
    never a Domain Admin bind for routine reads (CLAUDE.md §6).
    """
    server = Server(
        settings.ldap_uri,
        tls=_tls(settings),
        connect_timeout=settings.ldap_timeout_seconds,
    )
    conn = Connection(
        server,
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
    """Resolve an already-authenticated Kerberos principal and gate on the group.

    Used by the SPNEGO path, where no password ever reaches ODM.
    Blocking; call through run_in_threadpool.
    """
    validate_username(upn)
    conn = service_connection(settings)
    try:
        user = _lookup_user(settings, conn, upn, upn.partition("@")[0])
        group_dn = _lookup_group_dn(settings, conn, settings.admin_group)
        if not _is_member(settings, conn, user.dn, group_dn):
            raise NotAuthorized(f"not a member of {settings.admin_group}")
        return user
    finally:
        conn.unbind()


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
        sid=str(attrs["objectSid"]) if attrs.get("objectSid") else None,
    )


def _lookup_group_dn(settings: Settings, conn: Connection, group_name: str) -> str:
    filt = f"(&(objectClass=group)(sAMAccountName={escape_filter_chars(group_name)}))"
    entries = _search(conn, settings.base_dn, filt, ["distinguishedName"])
    if len(entries) != 1:
        raise DirectoryError(f"admin group {group_name!r} did not resolve to one object")
    return entries[0]["dn"]


def _is_member(settings: Settings, conn: Connection, user_dn: str, group_dn: str) -> bool:
    # ponytail: does not cover the case where the admin group is the user's
    # *primary* group (primaryGroupID), which memberOf never reflects. That
    # configuration is pathological for Domain Admins; add objectSid/RID
    # comparison here if a deployment actually needs it.
    entries = _search(
        conn,
        settings.base_dn,
        nested_member_filter(user_dn, group_dn),
        ["distinguishedName"],
    )
    return len(entries) == 1
