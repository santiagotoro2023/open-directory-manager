"""Directory object CRUD against the Samba AD DC.

Everything here is blocking ldap3 work — call it through run_in_threadpool.
Authorization happens above this layer (an ODM session only exists for a
member of the admin group); this module's job is to be impossible to abuse
by input alone: attribute names come from per-type allow-lists, every DN the
caller supplies is parsed and proven to sit under the domain head, and the
objects a domain cannot function without are refused outright.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ldap3 import (
    BASE,
    LEVEL,
    MODIFY_ADD,
    MODIFY_DELETE,
    MODIFY_REPLACE,
    SUBTREE,
    Connection,
)
from ldap3.core.exceptions import LDAPException
from ldap3.utils.conv import escape_filter_chars
from ldap3.utils.dn import escape_rdn, parse_dn, safe_dn

from .config import Settings
from .directory import DirectoryError, validate_username

UF_ACCOUNTDISABLE = 0x0002
UF_NORMAL_ACCOUNT = 0x0200
UF_WORKSTATION_TRUST_ACCOUNT = 0x1000

# groupType bit 0x80000000 marks a security group; the low bits are scope.
GROUP_TYPES = {
    "global-security": -2147483646,
    "domain-local-security": -2147483644,
    "universal-security": -2147483640,
    "global-distribution": 2,
    "domain-local-distribution": 4,
    "universal-distribution": 8,
}

# Objects whose removal breaks the domain. Deleting their *contents* is fine.
_PROTECTED_RDNS = (
    "cn=builtin",
    "cn=users",
    "cn=computers",
    "cn=system",
    "cn=managed service accounts",
    "ou=domain controllers",
)
_PROTECTED_NAMES = {
    "administrator",
    "domain admins",
    "domain users",
    "domain computers",
    "domain controllers",
    "enterprise admins",
    "schema admins",
    "guest",
    "krbtgt",
}


class ObjectError(Exception):
    """The directory refused the operation."""


class ProtectedObject(Exception):
    """Refused: removing or moving this would break the domain."""


class NotFound(Exception):
    """No such object under the domain head."""


@dataclass(frozen=True)
class TypeSpec:
    ldap_filter: str
    object_classes: list[str]
    rdn_attribute: str
    attributes: list[str]
    editable: frozenset[str]


COMMON_ATTRS = ["distinguishedName", "objectClass", "description", "whenCreated", "whenChanged"]

TYPES: dict[str, TypeSpec] = {
    "user": TypeSpec(
        ldap_filter="(&(objectCategory=person)(objectClass=user))",
        object_classes=["top", "person", "organizationalPerson", "user"],
        rdn_attribute="cn",
        attributes=[
            *COMMON_ATTRS,
            "cn",
            "sAMAccountName",
            "userPrincipalName",
            "givenName",
            "sn",
            "displayName",
            "mail",
            "telephoneNumber",
            "title",
            "department",
            "company",
            "physicalDeliveryOfficeName",
            "userAccountControl",
            "memberOf",
            "lastLogonTimestamp",
            "pwdLastSet",
            "accountExpires",
        ],
        editable=frozenset(
            {
                "givenName",
                "sn",
                "displayName",
                "mail",
                "telephoneNumber",
                "title",
                "department",
                "company",
                "physicalDeliveryOfficeName",
                "description",
                "userPrincipalName",
            }
        ),
    ),
    "group": TypeSpec(
        ldap_filter="(objectClass=group)",
        object_classes=["top", "group"],
        rdn_attribute="cn",
        attributes=[*COMMON_ATTRS, "cn", "sAMAccountName", "groupType", "member", "memberOf",
                    "mail", "managedBy"],
        editable=frozenset({"description", "mail"}),
    ),
    "computer": TypeSpec(
        ldap_filter="(objectClass=computer)",
        object_classes=["top", "person", "organizationalPerson", "user", "computer"],
        rdn_attribute="cn",
        attributes=[
            *COMMON_ATTRS,
            "cn",
            "sAMAccountName",
            "dNSHostName",
            "operatingSystem",
            "operatingSystemVersion",
            "userAccountControl",
            "memberOf",
            "lastLogonTimestamp",
        ],
        editable=frozenset({"description", "dNSHostName"}),
    ),
    "ou": TypeSpec(
        ldap_filter="(objectClass=organizationalUnit)",
        object_classes=["top", "organizationalUnit"],
        rdn_attribute="ou",
        attributes=[*COMMON_ATTRS, "ou", "managedBy", "gPLink", "gPOptions"],
        editable=frozenset({"description"}),
    ),
}

CONTAINER_FILTER = (
    "(|(objectClass=organizationalUnit)(objectClass=container)(objectClass=builtinDomain)"
    "(objectClass=domainDNS))"
)


# --------------------------------------------------------------- utilities ---


def _jsonable(value: Any) -> Any:
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    return value


def normalize_dn(settings: Settings, dn: str) -> str:
    """Parse a caller-supplied DN and prove it is inside the domain head.

    Anything malformed, empty, or outside the domain is rejected before it
    can reach the directory — this is the object-confusion guard for every
    endpoint that takes a DN.
    """
    if not dn or len(dn) > 1024:
        raise NotFound("invalid distinguished name")
    try:
        parse_dn(dn)
        canonical = safe_dn(dn)
    except LDAPException as exc:
        raise NotFound("invalid distinguished name") from exc
    base = safe_dn(settings.base_dn).lower()
    if canonical.lower() != base and not canonical.lower().endswith("," + base):
        raise NotFound("distinguished name is outside the domain")
    return canonical


def parent_dn(dn: str) -> str:
    return dn.split(",", 1)[1] if "," in dn else ""


def rdn_value(dn: str) -> str:
    first = dn.split(",", 1)[0]
    return first.split("=", 1)[1] if "=" in first else first


def assert_mutable(settings: Settings, dn: str, entry: dict | None = None) -> None:
    """Refuse changes to objects the domain cannot function without."""
    canonical = normalize_dn(settings, dn).lower()
    base = safe_dn(settings.base_dn).lower()
    if canonical == base:
        raise ProtectedObject("the domain head cannot be modified here")
    relative = canonical[: -(len(base) + 1)]
    if relative in _PROTECTED_RDNS or relative.endswith(",cn=builtin"):
        raise ProtectedObject("built-in containers and groups are protected")
    name = (entry or {}).get("sAMAccountName") or rdn_value(canonical)
    if str(name).lower() in _PROTECTED_NAMES or str(name).lower() == settings.admin_group.lower():
        raise ProtectedObject(f"{name} is a protected built-in object")


def _check(conn: Connection, action: str) -> None:
    if conn.result["result"] != 0:
        description = conn.result.get("description", "unknown")
        message = conn.result.get("message") or ""
        raise ObjectError(f"{action} failed: {description} {message}".strip())


def _entry(raw: dict) -> dict[str, Any]:
    attributes = {k: _jsonable(v) for k, v in raw["attributes"].items() if v not in ([], "")}
    attributes["distinguishedName"] = raw["dn"]
    attributes["objectType"] = _classify(raw["attributes"].get("objectClass") or [])
    return attributes


def _classify(object_classes: list[str]) -> str:
    lowered = {c.lower() for c in object_classes}
    if "computer" in lowered:
        return "computer"
    if "group" in lowered:
        return "group"
    if "organizationalunit" in lowered:
        return "ou"
    if "user" in lowered:
        return "user"
    if "domaindns" in lowered:
        return "domain"
    return "container"


def _search(
    conn: Connection,
    base: str,
    ldap_filter: str,
    attributes: list[str],
    scope: str = SUBTREE,
    limit: int = 0,
) -> list[dict]:
    try:
        conn.search(
            search_base=base,
            search_filter=ldap_filter,
            search_scope=scope,
            attributes=attributes,
            paged_size=limit or None,
        )
    except LDAPException as exc:
        raise DirectoryError(f"ldap search failed: {exc}") from exc
    if conn.result["result"] not in (0, 4):  # 4 = sizeLimitExceeded, expected when paging
        _check(conn, "search")
    return [e for e in conn.response if e.get("type") == "searchResEntry"]


# ------------------------------------------------------------------- reads ---


def get(conn: Connection, settings: Settings, dn: str) -> dict[str, Any]:
    canonical = normalize_dn(settings, dn)
    found = _search(conn, canonical, "(objectClass=*)", ["*", "memberOf"], scope=BASE)
    if not found:
        raise NotFound(f"{dn} not found")
    return _entry(found[0])


def search(
    conn: Connection,
    settings: Settings,
    *,
    object_type: str | None,
    container: str | None,
    query: str | None,
    scope: str,
    limit: int,
) -> tuple[list[dict[str, Any]], bool]:
    """List objects in a container, or search the subtree by name."""
    base = normalize_dn(settings, container) if container else safe_dn(settings.base_dn)

    if object_type is not None and object_type not in TYPES:
        raise ObjectError(f"unknown object type {object_type!r}")
    specs = [TYPES[object_type]] if object_type else list(TYPES.values())
    type_filter = "".join(spec.ldap_filter for spec in specs)
    if len(specs) > 1:
        type_filter = f"(|{type_filter})"

    if query:
        needle = escape_filter_chars(query.strip())
        name_filter = (
            f"(|(cn=*{needle}*)(sAMAccountName=*{needle}*)(displayName=*{needle}*)"
            f"(ou=*{needle}*)(mail=*{needle}*))"
        )
        ldap_filter = f"(&{type_filter}{name_filter})"
    else:
        ldap_filter = type_filter

    attributes = sorted({a for spec in specs for a in spec.attributes} | {"objectClass"})
    raw = _search(
        conn,
        base,
        ldap_filter,
        attributes,
        scope=SUBTREE if scope == "subtree" else LEVEL,
        limit=limit + 1,
    )
    truncated = len(raw) > limit
    return [_entry(e) for e in raw[:limit]], truncated


def find_computer(
    conn: Connection,
    settings: Settings,
    *,
    sam_account_name: str | None = None,
    dns_host_name: str | None = None,
) -> dict[str, Any]:
    """Resolve a computer account from what a Kerberos principal tells us."""
    clauses = []
    if sam_account_name:
        clauses.append(f"(sAMAccountName={escape_filter_chars(sam_account_name)})")
    if dns_host_name:
        clauses.append(f"(dNSHostName={escape_filter_chars(dns_host_name)})")
        short = dns_host_name.split(".", 1)[0]
        clauses.append(f"(sAMAccountName={escape_filter_chars(short)}$)")
    if not clauses:
        raise NotFound("no computer identity supplied")

    found = _search(
        conn,
        safe_dn(settings.base_dn),
        f"(&(objectClass=computer)(|{''.join(clauses)}))",
        TYPES["computer"].attributes,
    )
    if len(found) != 1:
        raise NotFound("computer account could not be resolved unambiguously")
    return _entry(found[0])


def find_user(conn: Connection, settings: Settings, sam_account_name: str) -> dict[str, Any]:
    """Resolve a user account by logon name."""
    validate_username(sam_account_name)
    found = _search(
        conn,
        safe_dn(settings.base_dn),
        "(&(objectCategory=person)(objectClass=user)"
        f"(sAMAccountName={escape_filter_chars(sam_account_name)}))",
        TYPES["user"].attributes,
    )
    if len(found) != 1:
        raise NotFound("user could not be resolved unambiguously")
    return _entry(found[0])


def containers(conn: Connection, settings: Settings) -> list[dict[str, Any]]:
    """Every OU and built-in container, for the navigation tree."""
    raw = _search(
        conn,
        safe_dn(settings.base_dn),
        CONTAINER_FILTER,
        ["distinguishedName", "objectClass", "name", "ou", "cn", "description"],
        scope=SUBTREE,
    )
    nodes = [_entry(e) for e in raw]
    nodes.sort(key=lambda n: n["distinguishedName"].lower())
    return nodes


# ------------------------------------------------------------------ writes ---


def create_user(conn: Connection, settings: Settings, payload: dict[str, Any]) -> str:
    sam = validate_username(str(payload["sam_account_name"]))
    name = str(payload.get("name") or sam).strip()
    container = normalize_dn(settings, payload["container"])
    dn = f"CN={escape_rdn(name)},{container}"

    attributes: dict[str, Any] = {
        "cn": name,
        "sAMAccountName": sam,
        "userPrincipalName": payload.get("user_principal_name") or f"{sam}@{settings.domain}",
        # Created disabled; enabled by the password set below, so an account
        # is never briefly reachable without a password.
        "userAccountControl": UF_NORMAL_ACCOUNT | UF_ACCOUNTDISABLE,
    }
    for attribute, field in (
        ("givenName", "given_name"),
        ("sn", "surname"),
        ("displayName", "display_name"),
        ("mail", "mail"),
        ("description", "description"),
    ):
        if payload.get(field):
            attributes[attribute] = str(payload[field])

    try:
        conn.add(dn, TYPES["user"].object_classes, attributes)
    except LDAPException as exc:
        raise DirectoryError(f"create failed: {exc}") from exc
    _check(conn, "create user")

    password = payload.get("password")
    if password:
        set_password(conn, settings, dn, password, bool(payload.get("must_change_password")))
        set_enabled(conn, settings, dn, enabled=payload.get("enabled", True))
    return dn


def create_group(conn: Connection, settings: Settings, payload: dict[str, Any]) -> str:
    name = validate_username(str(payload["name"]))
    container = normalize_dn(settings, payload["container"])
    scope = str(payload.get("group_type") or "global-security")
    if scope not in GROUP_TYPES:
        raise ObjectError(f"unknown group type {scope!r}")

    dn = f"CN={escape_rdn(name)},{container}"
    attributes = {
        "cn": name,
        "sAMAccountName": name,
        "groupType": GROUP_TYPES[scope],
    }
    if payload.get("description"):
        attributes["description"] = str(payload["description"])
    conn.add(dn, TYPES["group"].object_classes, attributes)
    _check(conn, "create group")
    return dn


def create_computer(conn: Connection, settings: Settings, payload: dict[str, Any]) -> str:
    name = validate_username(str(payload["name"])).rstrip("$")
    container = normalize_dn(settings, payload["container"])
    dn = f"CN={escape_rdn(name)},{container}"
    attributes = {
        "cn": name,
        "sAMAccountName": f"{name}$",
        "userAccountControl": UF_WORKSTATION_TRUST_ACCOUNT,
    }
    for attribute, field in (("dNSHostName", "dns_host_name"), ("description", "description")):
        if payload.get(field):
            attributes[attribute] = str(payload[field])
    conn.add(dn, TYPES["computer"].object_classes, attributes)
    _check(conn, "create computer")
    return dn


def create_ou(conn: Connection, settings: Settings, payload: dict[str, Any]) -> str:
    name = str(payload["name"]).strip()
    if not name or len(name) > 64 or any(c in name for c in "\\/#+<>;\"="):
        raise ObjectError("invalid organizational unit name")
    container = normalize_dn(settings, payload["container"])
    dn = f"OU={escape_rdn(name)},{container}"
    attributes = {"ou": name}
    if payload.get("description"):
        attributes["description"] = str(payload["description"])
    conn.add(dn, TYPES["ou"].object_classes, attributes)
    _check(conn, "create organizational unit")
    return dn


def update(
    conn: Connection, settings: Settings, dn: str, changes: dict[str, Any]
) -> dict[str, Any]:
    """Replace allow-listed attributes. Empty value clears the attribute."""
    canonical = normalize_dn(settings, dn)
    current = get(conn, settings, canonical)
    spec = TYPES.get(current["objectType"])
    if spec is None:
        raise ObjectError(f"{current['objectType']} objects cannot be edited")

    unknown = set(changes) - spec.editable
    if unknown:
        raise ObjectError(f"not editable: {', '.join(sorted(unknown))}")

    modifications = {
        attribute: [(MODIFY_REPLACE, [value] if value not in (None, "") else [])]
        for attribute, value in changes.items()
    }
    if modifications:
        conn.modify(canonical, modifications)
        _check(conn, "update")
    return get(conn, settings, canonical)


def set_enabled(conn: Connection, settings: Settings, dn: str, *, enabled: bool) -> None:
    canonical = normalize_dn(settings, dn)
    current = get(conn, settings, canonical)
    uac = int(current.get("userAccountControl") or UF_NORMAL_ACCOUNT)
    uac = uac & ~UF_ACCOUNTDISABLE if enabled else uac | UF_ACCOUNTDISABLE
    conn.modify(canonical, {"userAccountControl": [(MODIFY_REPLACE, [uac])]})
    _check(conn, "set account state")


def set_password(
    conn: Connection, settings: Settings, dn: str, password: str, must_change: bool = False
) -> None:
    """Set unicodePwd over the existing LDAPS channel, as AD requires.

    The quoted-UTF-16LE encoding is the documented AD wire format, not
    cryptography of our own (CLAUDE.md §6). Passwords are never logged.
    """
    canonical = normalize_dn(settings, dn)
    if not password or len(password) > 256:
        raise ObjectError("invalid password")
    encoded = f'"{password}"'.encode("utf-16-le")
    conn.modify(canonical, {"unicodePwd": [(MODIFY_REPLACE, [encoded])]})
    _check(conn, "set password")
    if must_change:
        conn.modify(canonical, {"pwdLastSet": [(MODIFY_REPLACE, [0])]})
        _check(conn, "force password change")


def move(
    conn: Connection, settings: Settings, dn: str, target: str, new_name: str | None = None
) -> str:
    canonical = normalize_dn(settings, dn)
    assert_mutable(settings, canonical)
    destination = normalize_dn(settings, target)
    if destination.lower() == canonical.lower() or destination.lower().endswith(
        "," + canonical.lower()
    ):
        raise ObjectError("cannot move an object into itself")

    attribute = canonical.split("=", 1)[0]
    name = new_name.strip() if new_name else rdn_value(canonical)
    relative = f"{attribute}={escape_rdn(name)}"
    conn.modify_dn(canonical, relative, new_superior=destination)
    _check(conn, "move")
    return f"{relative},{destination}"


def snapshot(conn: Connection, settings: Settings, dn: str) -> dict[str, Any]:
    """Full object state for the recycle bin, taken before a delete."""
    canonical = normalize_dn(settings, dn)
    entry = get(conn, settings, canonical)
    children = _search(
        conn, canonical, "(objectClass=*)", ["distinguishedName"], scope=LEVEL
    )
    return {
        "object_dn": canonical,
        "object_type": entry["objectType"],
        "display_name": entry.get("displayName") or entry.get("cn") or entry.get("ou"),
        "parent_dn": parent_dn(canonical),
        "attributes": entry,
        "memberships": entry.get("memberOf") or [],
        "members": entry.get("member") or [],
        "children": [c["dn"] for c in children],
    }


def delete(conn: Connection, settings: Settings, dn: str) -> dict[str, Any]:
    """Snapshot, then delete. Returns the snapshot for the recycle bin."""
    canonical = normalize_dn(settings, dn)
    state = snapshot(conn, settings, canonical)
    assert_mutable(settings, canonical, state["attributes"])
    if state["children"]:
        raise ObjectError("container is not empty")
    conn.delete(canonical)
    _check(conn, "delete")
    return state


def edit_members(
    conn: Connection,
    settings: Settings,
    group_dn: str,
    *,
    add: list[str],
    remove: list[str],
) -> dict[str, Any]:
    """Bulk membership edit. Members already present or absent are not errors."""
    canonical = normalize_dn(settings, group_dn)
    entry = get(conn, settings, canonical)
    if entry["objectType"] != "group":
        raise ObjectError("not a group")

    existing = {m.lower() for m in (entry.get("member") or [])}
    to_add = [normalize_dn(settings, m) for m in add]
    to_remove = [normalize_dn(settings, m) for m in remove]
    to_add = [m for m in to_add if m.lower() not in existing]
    to_remove = [m for m in to_remove if m.lower() in existing]

    if to_add:
        conn.modify(canonical, {"member": [(MODIFY_ADD, to_add)]})
        _check(conn, "add members")
    if to_remove:
        conn.modify(canonical, {"member": [(MODIFY_DELETE, to_remove)]})
        _check(conn, "remove members")
    return get(conn, settings, canonical)
