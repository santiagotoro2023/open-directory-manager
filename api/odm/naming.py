"""Computer names by policy: a template, and the next number in it.

A "Computer names" setting on a policy object says what the machines it
reaches are called — `WS-{n:4}` — and the control plane, which is the one
thing that can see the whole fleet, hands each machine that does not fit the
pattern the next free number. The number is assigned once, recorded here,
and given back on every later policy pull, so a machine that was told it is
WS-0042 stays WS-0042 however many times it asks; a machine that already fits
the pattern (named by hand, or by an earlier assignment) is left alone.

The rename itself — the directory object, its account, its keytab, and then
the machine — is in routes_agent (rename) and on the agent (apply/hostname).
"""

from __future__ import annotations

import re
from typing import Any

import asyncpg
from ldap3 import Connection

from . import objects
from .config import Settings

# What a template may hold: letters, digits and dashes, and the placeholders.
TEMPLATE_RE = re.compile(r"^[A-Za-z0-9-]*(\{n(?::\d)?\}|\{serial\})?[A-Za-z0-9-]*$")
PLACEHOLDER_RE = re.compile(r"\{n(?::(\d))?\}")


def validate_template(template: str) -> str:
    template = template.strip()
    if not template or len(template) > 40 or not TEMPLATE_RE.match(template):
        raise ValueError(
            "a template is letters, digits and dashes around one {n} — WS-{n:4} — or {serial}"
        )
    if "{n" not in template and "{serial}" not in template:
        raise ValueError("a template needs {n} or {serial}, or every machine would get one name")
    return template


def pattern_of(template: str) -> re.Pattern[str]:
    """The names a template produces, as a pattern that also captures the number."""
    if "{serial}" in template:
        prefix, suffix = template.split("{serial}", 1)
        return re.compile(rf"^{re.escape(prefix)}[a-z0-9]+{re.escape(suffix)}$", re.I)
    match = PLACEHOLDER_RE.search(template)
    assert match is not None
    prefix, suffix = template[: match.start()], template[match.end() :]
    return re.compile(rf"^{re.escape(prefix)}(\d+){re.escape(suffix)}$", re.I)


def render(template: str, number: int | None = None, serial: str = "") -> str:
    if "{serial}" in template:
        clean = re.sub(r"[^A-Za-z0-9]", "", serial).lower()[:20] or "unknown"
        return template.replace("{serial}", clean)
    match = PLACEHOLDER_RE.search(template)
    assert match is not None and number is not None
    width = int(match.group(1) or 1)
    return template[: match.start()] + str(number).zfill(width) + template[match.end() :]


def fits(template: str, short_name: str) -> bool:
    return bool(pattern_of(template).match(short_name))


async def assign(
    pool: asyncpg.Pool,
    conn: Connection,
    settings: Settings,
    *,
    dn: str,
    current_short: str,
    template: str,
    serial: str = "",
) -> str | None:
    """The short name this machine should have under the template, or None
    when its current name already fits. Assigned once and remembered."""
    if fits(template, current_short):
        return None
    existing = await pool.fetchrow(
        "SELECT name, template FROM hostname_assignment WHERE lower(computer_dn) = lower($1)", dn
    )
    if existing and existing["template"] == template:
        return str(existing["name"])

    if "{serial}" in template:
        name = render(template, serial=serial)
    else:
        name = render(template, number=await _next_number(pool, conn, settings, template))
    await pool.execute(
        """
        INSERT INTO hostname_assignment (computer_dn, name, template)
        VALUES ($1, $2, $3)
        ON CONFLICT (computer_dn) DO UPDATE SET name = excluded.name, template = excluded.template,
                                              assigned_at = now()
        """,
        dn,
        name,
        template,
    )
    return name


async def _next_number(
    pool: asyncpg.Pool, conn: Connection, settings: Settings, template: str
) -> int:
    """One past the highest number in use — in the directory or already
    handed out — so a machine deleted in the middle leaves a gap rather than
    a name that comes round again."""
    pattern = pattern_of(template)
    highest = 0
    found, _ = objects.search(
        conn, settings, object_type="computer", container=None, query=None,
        scope="subtree", limit=0,
    )
    for entry in found:
        short = str(entry.get("cn") or "").split(".")[0]
        if match := pattern.match(short):
            highest = max(highest, int(match.group(1)))
    rows = await pool.fetch("SELECT name FROM hostname_assignment WHERE template = $1", template)
    for row in rows:
        if match := pattern.match(str(row["name"])):
            highest = max(highest, int(match.group(1)))
    return highest + 1


def describe(template: str) -> dict[str, Any]:
    """For the console: what the template looks like filled in."""
    if "{serial}" in template:
        return {"example": render(template, serial="ABC123XYZ")}
    return {"example": render(template, number=42)}
