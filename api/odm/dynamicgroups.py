"""Groups whose membership is a question rather than a list.

Everybody in an organizational unit, everybody with a title, every machine
running Debian 13 — memberships that are true by definition and that somebody
otherwise has to remember to keep true by hand.

The query is built out of named conditions rather than typed as an LDAP
filter. A filter typed by hand is a filter nobody reviews, and one that is
subtly wrong quietly empties a group that a sudo rule or a share depends on.
"""

from __future__ import annotations

from typing import Any

from ldap3.utils.conv import escape_filter_chars

# Which attributes a condition may be about, and what they are called in the
# console. Deliberately a short list: these are the ones an estate actually
# organises itself by, and every one of them is indexed in Active Directory.
ATTRIBUTES: dict[str, str] = {
    "department": "Department",
    "title": "Title",
    "company": "Company",
    "physicalDeliveryOfficeName": "Office",
    "description": "Description",
    "userPrincipalName": "User principal name",
    "sAMAccountName": "Account name",
    "operatingSystem": "Operating system",
    "dNSHostName": "Host name",
}

OPERATORS = ("is", "is not", "starts with", "contains", "is set", "is not set")

OBJECT_FILTERS = {
    "user": "(&(objectCategory=person)(objectClass=user))",
    "computer": "(objectClass=computer)",
}


class QueryError(Exception):
    """The query is not one ODM will run."""


def validate(conditions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Check every condition, and hand back the cleaned set."""
    if len(conditions) > 16:
        raise QueryError("a group query may have at most sixteen conditions")
    cleaned = []
    for condition in conditions:
        attribute = str(condition.get("attribute") or "")
        operator = str(condition.get("operator") or "")
        value = str(condition.get("value") or "")
        if attribute not in ATTRIBUTES:
            raise QueryError(f"{attribute!r} is not an attribute a group query can be about")
        if operator not in OPERATORS:
            raise QueryError(f"{operator!r} is not a comparison")
        if operator in ("is set", "is not set"):
            value = ""
        elif not value:
            raise QueryError(f"{ATTRIBUTES[attribute]} {operator} what?")
        if len(value) > 256:
            raise QueryError("a value may be at most 256 characters")
        cleaned.append({"attribute": attribute, "operator": operator, "value": value})
    if not cleaned:
        raise QueryError("a group query needs at least one condition")
    return cleaned


def build_filter(
    object_type: str, conditions: list[dict[str, Any]], match_all: bool
) -> str:
    """The LDAP filter these conditions mean.

    Every value is escaped on the way in: this reaches the directory as a
    search, and a value carrying a parenthesis would otherwise be a filter of
    the caller's choosing rather than the operator's.
    """
    base = OBJECT_FILTERS.get(object_type)
    if base is None:
        raise QueryError(f"a group query is about users or computers, not {object_type!r}")

    parts = []
    for condition in conditions:
        attribute = condition["attribute"]
        if attribute not in ATTRIBUTES:
            raise QueryError(f"{attribute!r} is not an attribute a group query can be about")
        value = escape_filter_chars(condition["value"])
        match condition["operator"]:
            case "is":
                parts.append(f"({attribute}={value})")
            case "is not":
                parts.append(f"(!({attribute}={value}))")
            case "starts with":
                parts.append(f"({attribute}={value}*)")
            case "contains":
                parts.append(f"({attribute}=*{value}*)")
            case "is set":
                parts.append(f"({attribute}=*)")
            case "is not set":
                parts.append(f"(!({attribute}=*))")
            case other:
                raise QueryError(f"{other!r} is not a comparison")

    joined = "".join(parts)
    combined = f"(&{joined})" if match_all else f"(|{joined})"
    return f"(&{base}{combined})"


def describe(conditions: list[dict[str, Any]], match_all: bool) -> str:
    """The query in a sentence, for a list that has no room for the detail."""
    joiner = " and " if match_all else " or "
    return joiner.join(
        f"{ATTRIBUTES.get(c['attribute'], c['attribute'])} {c['operator']} {c['value']}".strip()
        for c in conditions
    )


def membership_change(
    current: list[str], wanted: list[str]
) -> tuple[list[str], list[str]]:
    """Who to add and who to remove, by distinguished name.

    Case-insensitively, because a distinguished name read back from the
    directory is not always cased the way it was written, and comparing them
    literally makes every run add and remove the same people for ever.
    """
    have = {dn.lower(): dn for dn in current}
    want = {dn.lower(): dn for dn in wanted}
    add = [want[key] for key in want.keys() - have.keys()]
    remove = [have[key] for key in have.keys() - want.keys()]
    return sorted(add), sorted(remove)
