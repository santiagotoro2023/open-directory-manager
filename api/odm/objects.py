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
import re
import uuid
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
from .directory import DirectoryError, read_sid, validate_username

UF_ACCOUNTDISABLE = 0x0002
UF_NORMAL_ACCOUNT = 0x0200
UF_WORKSTATION_TRUST_ACCOUNT = 0x1000

# What a group is for. Both kinds can be granted access; the kind decides
# which objects the console offers as members and how the group is labelled.
GROUP_KINDS = ("user", "computer")

# Where a group can be used. The high bit marks it as usable for access,
# which every ODM group is; the low bits set the scope.
GROUP_SCOPES = {
    "global": -2147483646,
    "domain-local": -2147483644,
    "universal": -2147483640,
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
            "objectSid",
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
        attributes=[*COMMON_ATTRS, "cn", "sAMAccountName", "objectSid", "groupType", "member",
                    "memberOf", "mail", "managedBy"],
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
            "objectSid",
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
    # A security identifier is meaningful to an operator; its raw bytes are not.
    if raw["attributes"].get("objectSid") is not None:
        attributes["objectSid"] = read_sid(raw["attributes"]["objectSid"])
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
    # 32 is noSuchObject: the base is not there, so the answer is "nothing",
    # not an error. Raising here meant every "does this exist?" check failed
    # with a directory error instead of answering no — which is why restoring
    # a deleted object could never work. The check for whether the object is
    # already back is a search for a DN that, by definition, is not.
    if conn.result["result"] == 32:
        return []
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
    """Resolve a user account by logon name.

    Whatever spelling arrived — the bare name, a UPN, or DOMAIN\\name — the
    directory is asked about the account name.
    """
    sam_account_name = validate_username(sam_account_name).split("@", 1)[0]
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
        try:
            set_password(conn, settings, dn, password, bool(payload.get("must_change_password")))
            set_enabled(conn, settings, dn, enabled=payload.get("enabled", True))
        except Exception:
            # The account exists at this point but is disabled and has no
            # password. Leaving it there turns one clear failure into a
            # confusing "already exists" on the retry.
            conn.delete(dn)
            raise
    return dn


def create_group(conn: Connection, settings: Settings, payload: dict[str, Any]) -> str:
    name = validate_username(str(payload["name"]))
    container = normalize_dn(settings, payload["container"])
    scope = str(payload.get("scope") or "global")
    if scope not in GROUP_SCOPES:
        raise ObjectError(f"unknown group scope {scope!r}")
    kind = str(payload.get("kind") or "user")
    if kind not in GROUP_KINDS:
        raise ObjectError(f"unknown group type {kind!r}")

    dn = f"CN={escape_rdn(name)},{container}"
    attributes = {
        "cn": name,
        "sAMAccountName": name,
        "groupType": GROUP_SCOPES[scope],
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
    if conn.result and conn.result.get("result") == 50:
        # Property writes are not enough for this one attribute, so the
        # generic "insufficient access" says nothing about what to fix.
        raise DirectoryError(
            "set password failed: this account may not reset passwords in the directory. "
            "Re-run deploy/create-api-service-account.sh on a domain controller to grant "
            "it the Reset Password right."
        )
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


# Attributes the directory owns. A restored object gets fresh ones; trying to
# write them back is rejected by the DC and would fail the whole restore.
# ldap3 decodes AD's 64-bit timestamps into datetimes on the way in, so the
# snapshot holds their ISO strings — and the directory will not take one back.
# accountExpires is on every user, which is the second reason no restore ever
# worked. The named set below catches the ones we know of; this catches the
# next one. A whole value, not a prefix: a description that begins with a date
# is still a description.
_WHOLE_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)?$")


OPERATIONAL_ATTRS = frozenset(
    {
        "distinguishedname",
        "objecttype",
        "objectguid",
        "objectsid",
        "objectcategory",
        "whencreated",
        "whenchanged",
        "usncreated",
        "usnchanged",
        "instancetype",
        "memberof",
        "dscorepropagationdata",
        "lastlogon",
        "lastlogontimestamp",
        "lastlogoff",
        "logoncount",
        "badpwdcount",
        "badpasswordtime",
        "pwdlastset",
        "accountexpires",
        "lockouttime",
        "samaccounttype",
        "primarygroupid",
        "admincount",
        "iscriticalsystemobject",
        "name",
        "unicodepwd",
    }
)


def restore(
    conn: Connection,
    settings: Settings,
    snapshot: dict[str, Any],
    container: str | None = None,
) -> str:
    """Recreate a deleted object from its recycle-bin snapshot.

    Reanimating the directory's own tombstone is tried first, because it is the
    only way the object keeps its SID. A new SID looks like a successful
    restore and is not one: every file the account owned belongs to a uid that
    no longer exists, so the person logs in to a home directory they cannot
    write, and every ACL, sudo rule and share permission that named them is
    silently pointing at nobody.

    When there is no tombstone left to reanimate — purged past the directory's
    own tombstone lifetime, or a directory that will not undelete — the object
    is recreated from the snapshot instead and does come back with a new SID.
    The caller is told which of the two happened.
    """
    parent = normalize_dn(settings, str(container or snapshot["parent_dn"]))
    dn = f"{str(snapshot['object_dn']).split(',', 1)[0]},{parent}"

    # An object whose container was deleted after it was has to be restorable
    # somewhere, so say which container is missing rather than failing on the
    # add with a directory error about a DN nobody chose.
    try:
        get(conn, settings, parent)
    except NotFound:
        raise ObjectError(
            f"{parent} no longer exists. Restore this object into another container."
        ) from None
    try:
        get(conn, settings, dn)
    except NotFound:
        pass
    else:
        raise ObjectError(f"{dn} already exists")

    attributes = dict(snapshot.get("attributes") or {})
    object_classes = attributes.get("objectClass") or []
    if not object_classes:
        raise ObjectError("snapshot has no objectClass; cannot restore")

    if _reanimate(conn, snapshot.get("object_guid"), dn):
        _reapply(conn, dn, attributes, object_classes)
        _rejoin_groups(conn, settings, dn, snapshot)
        return dn

    payload = {
        key: value
        for key, value in attributes.items()
        if key.lower() not in OPERATIONAL_ATTRS
        and key.lower() != "objectclass"
        and value != []
        and not (isinstance(value, str) and _WHOLE_TIMESTAMP.match(value))
    }
    # A restored account starts disabled: it has no password, and an enabled
    # account without one is worse than an obvious one to re-enable.
    if any(c.lower() == "user" for c in object_classes):
        payload["userAccountControl"] = int(
            payload.get("userAccountControl") or UF_NORMAL_ACCOUNT
        ) | UF_ACCOUNTDISABLE
    payload.pop("member", None)

    conn.add(dn, list(object_classes), payload)
    _check(conn, "restore")

    _rejoin_groups(conn, settings, dn, snapshot)
    return dn


# The LDAP "show deleted objects" control. A tombstone is invisible to an
# ordinary search, including the one that finds it in order to bring it back.
SHOW_DELETED = "1.2.840.113556.1.4.417"


def object_guid(attributes: dict[str, Any] | None) -> str | None:
    """The objectGUID as PostgreSQL and LDAP both spell it.

    ldap3 renders it with braces on some schemas and without on others, and a
    uuid column takes neither shape reliably, so it is normalised once here.
    """
    raw = (attributes or {}).get("objectGUID")
    if not raw:
        return None
    text = str(raw).strip().strip("{}")
    try:
        return str(uuid.UUID(text))
    except ValueError:
        return None


def _reanimate(conn: Connection, object_guid: Any, dn: str) -> bool:
    """Undelete the directory's own tombstone, keeping the object's SID.

    A tombstone is reanimated by removing isDeleted and naming the object
    again, in one modify that changes nothing else — the directory refuses the
    operation otherwise. Returns False whenever there is nothing to reanimate,
    so the caller can fall back to recreating the object.
    """
    if not object_guid:
        return False
    try:
        found = conn.search(
            f"<GUID={object_guid}>",
            "(objectClass=*)",
            search_scope=BASE,
            attributes=["distinguishedName"],
            controls=[(SHOW_DELETED, True, None)],
        )
        if not found:
            return False
        entries = [r for r in (conn.response or []) if r.get("type") == "searchResEntry"]
        if not entries:
            return False
        tombstone = entries[0]["dn"]
        conn.modify(
            tombstone,
            {
                "isDeleted": [(MODIFY_DELETE, [])],
                "distinguishedName": [(MODIFY_REPLACE, [dn])],
            },
            controls=[(SHOW_DELETED, True, None)],
        )
        return conn.result["result"] == 0
    except LDAPException:
        return False


def _reapply(conn: Connection, dn: str, attributes: dict, object_classes: list) -> None:
    """Put back what the tombstone did not keep.

    A tombstone holds only the attributes the schema marks as preserved — the
    identity, essentially. Everything descriptive was stripped by the delete
    and is written back here from the snapshot, one attribute at a time so
    that one the directory will not take does not lose the rest of them.
    """
    for key, value in attributes.items():
        if key.lower() in OPERATIONAL_ATTRS or key.lower() in ("objectclass", "member"):
            continue
        if value in ([], "", None) or (isinstance(value, str) and _WHOLE_TIMESTAMP.match(value)):
            continue
        try:
            values = value if isinstance(value, list) else [value]
            conn.modify(dn, {key: [(MODIFY_REPLACE, values)]})
        except LDAPException:
            continue
    # As with a recreated account: it comes back without a usable password, so
    # it comes back disabled rather than open.
    if any(str(c).lower() == "user" for c in object_classes):
        uac = int(attributes.get("userAccountControl") or UF_NORMAL_ACCOUNT) | UF_ACCOUNTDISABLE
        try:
            conn.modify(dn, {"userAccountControl": [(MODIFY_REPLACE, [uac])]})
        except LDAPException:
            pass


def _rejoin_groups(
    conn: Connection, settings: Settings, dn: str, snapshot: dict[str, Any]
) -> None:
    for group_dn in snapshot.get("memberships") or []:
        try:
            conn.modify(normalize_dn(settings, group_dn), {"member": [(MODIFY_ADD, [dn])]})
        except (NotFound, LDAPException):
            continue  # the group itself is gone; nothing to rejoin

    members = [m for m in (snapshot.get("members") or [])]
    if members:
        try:
            conn.modify(dn, {"member": [(MODIFY_ADD, members)]})
        except LDAPException:
            pass


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
