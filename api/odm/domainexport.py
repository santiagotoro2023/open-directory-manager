"""Everything this domain is configured to be, in one file.

Two halves, because a domain has two: the objects in the directory — OUs,
groups, users, computers, and the DNS zones beside them — and ODM's own
record of everything built on top of them, which is every policy object and
its settings, every share, printer, DHCP scope, collection, role assignment
and delegation.

The point of putting them in one file is that the file is enough. An
operator can rebuild the domain from it on a machine that has never seen the
original, and anybody reading it can see every setting without being given
access to the running system — which is what makes it useful for support as
well as for restore.

What is deliberately not in it are credentials: private keys, RADIUS shared
secrets, VPN keys, rotated local-administrator passwords, join tokens,
second-factor seeds, and the directory's password hashes, which Samba does
not hand out anyway. An export is a document that gets copied, mailed and
pasted into an issue; a document that grants access to the domain it
describes is not one to make easy to produce. The reader is told which
values were withheld, and an import regenerates or asks for each.

An account restored from an export therefore comes back disabled with no
password. That is a truthful failure rather than a silent one: the
alternative is every account in the new domain having a password somebody
can read out of a file.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

import asyncpg

EXPORT_FORMAT = 1

# What happened, rather than what was configured. A restore wants the domain
# the file describes; it does not want yesterday's task queue, last month's
# sign-in attempts or the sessions of a console that is not running any more.
VOLATILE_TABLES = frozenset(
    {
        "admin_session",
        "agent_report",
        "audit_log",
        "computer_event",
        "computer_fact",
        "computer_log",
        "deleted_object",
        "domain_backup",
        "enrolled_certificate",
        "login_attempt",
        "node_task",
        "rd_session",
        "schema_migration",
        "schema_migrations",
        # A second factor is enrolled by the person holding the device. It
        # cannot be moved to another domain and must not be copied out of one.
        "totp_enrolment",
        # Every token is a way in that outlives the file it is written to.
        "join_token",
    }
)

# Columns that are a credential. Replaced by a marker rather than dropped, so
# a reader can see that the setting exists and that its secret was withheld.
SECRET_COLUMNS: dict[str, frozenset[str]] = {
    "ca_certificate": frozenset({"private_key"}),
    "vpn_tunnel": frozenset({"private_key"}),
    "vpn_peer": frozenset({"private_key"}),
    "radius_client": frozenset({"secret"}),
    "local_administrator": frozenset({"password"}),
}

WITHHELD = "<withheld from the export>"


def _plain(value: Any) -> Any:
    """Anything asyncpg hands back, as something json can write."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        # Not decoded: a bytea column is not text, and guessing an encoding
        # is how an export stops round-tripping.
        return {"__bytes__": value.hex()}
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def _restore(value: Any) -> Any:
    if isinstance(value, dict) and set(value) == {"__bytes__"}:
        return bytes.fromhex(value["__bytes__"])
    return value


async def config_tables(conn: asyncpg.Connection) -> list[str]:
    """Every table holding configuration, in dependency order.

    Read from the database rather than listed here: a feature added next
    month brings its own table, and an export that has to be edited to
    include it is an export that quietly stops being complete. The list of
    what to leave out is the part worth maintaining by hand.
    """
    rows = await conn.fetch(
        """
        SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname
        """
    )
    return [row["name"] for row in rows if row["name"] not in VOLATILE_TABLES]


async def database_section(conn: asyncpg.Connection) -> dict[str, Any]:
    """Every configuration row in ODM's own store."""
    section: dict[str, Any] = {}
    for table in await config_tables(conn):
        secrets = SECRET_COLUMNS.get(table, frozenset())
        rows = []
        for row in await conn.fetch(f'SELECT * FROM "{table}"'):  # noqa: S608 - name from pg_class
            record = {key: _plain(value) for key, value in dict(row).items()}
            for column in secrets:
                if record.get(column) not in (None, ""):
                    record[column] = WITHHELD
            rows.append(record)
        section[table] = rows
    return section


def withheld_in(section: dict[str, Any]) -> list[str]:
    """Which secrets the reader is not being shown, named so they know."""
    found = []
    for table, columns in SECRET_COLUMNS.items():
        rows = section.get(table) or []
        for column in sorted(columns):
            count = sum(1 for row in rows if row.get(column) == WITHHELD)
            if count:
                found.append(f"{table}.{column} ({count})")
    return sorted(found)


def snapshot_of(entry: dict[str, Any]) -> dict[str, Any]:
    """One directory object in the shape the recycle bin already restores.

    Deliberately the same shape: restoring an object from an export and
    restoring one from the recycle bin are the same operation, and there is no
    reason for two of it.
    """
    dn = str(entry["distinguishedName"])
    return {
        "object_dn": dn,
        "object_type": entry.get("objectType"),
        "display_name": entry.get("displayName") or entry.get("cn") or entry.get("ou"),
        "parent_dn": dn.split(",", 1)[1] if "," in dn else "",
        "attributes": entry,
        "memberships": entry.get("memberOf") or [],
        "members": entry.get("member") or [],
    }


# Records a domain controller writes for itself. An import must not try to put
# them back: the zone it is importing into already has its own, pointing at
# this domain's controllers rather than the ones the file was taken from.
OWNED_RECORD_TYPES = frozenset({"SOA", "NS"})


def importable_records(zone: str, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The records in a zone that are somebody's decision rather than the
    directory's own bookkeeping."""
    wanted = []
    for record in records:
        kind = str(record.get("type", "")).upper()
        if kind in OWNED_RECORD_TYPES:
            continue
        name = str(record.get("name", ""))
        # The controllers' own service records are rebuilt by the domain that
        # owns them; a file's copy names machines that are not in it.
        if name.startswith("_") or name in ("DomainDnsZones", "ForestDnsZones"):
            continue
        wanted.append({"name": name, "type": kind, "data": str(record.get("data", ""))})
    return wanted


# ------------------------------------------------------------------ import -


class ImportError_(Exception):
    """The file is not one ODM will read."""


def check(document: Any) -> dict[str, Any]:
    """Whether this is an export, and one of a format this version reads."""
    if not isinstance(document, dict):
        raise ImportError_("this is not an Open Directory Manager export")
    fmt = document.get("odm_export")
    if fmt != EXPORT_FORMAT:
        raise ImportError_(
            f"this file is export format {fmt!r}; this version reads format {EXPORT_FORMAT}"
        )
    return document


def summarise(document: dict[str, Any]) -> dict[str, Any]:
    """What importing this file would bring in, without importing it.

    Shown before anything is written, because an import replaces the
    configuration of the domain it runs against and nobody should be asked to
    agree to that without being told the size of it.
    """
    directory = document.get("directory") or {}
    database = document.get("database") or {}
    zones = document.get("dns", {}).get("zones") or []
    return {
        "taken_at": document.get("taken_at"),
        "from_version": document.get("version"),
        "from_domain": (document.get("domain") or {}).get("realm"),
        "organizational_units": len(directory.get("organizational_units") or []),
        "groups": len(directory.get("groups") or []),
        "users": len(directory.get("users") or []),
        "computers": len(directory.get("computers") or []),
        "dns_zones": len(zones),
        "dns_records": sum(len(zone.get("records") or []) for zone in zones),
        "tables": {name: len(rows) for name, rows in database.items() if rows},
        "withheld": document.get("withheld") or [],
    }


def rewrite_dn(dn: str, source_base: str, target_base: str) -> str:
    """The same object's place in this domain rather than the one it came from.

    An export taken from corp.example.internal and imported into a domain of
    another name has every distinguished name pointing at a base that does not
    exist here. Rewriting the suffix is what makes the file portable; an
    export imported into a domain of the same name changes nothing.
    """
    if not source_base or source_base.lower() == target_base.lower():
        return dn
    if dn.lower().endswith(source_base.lower()):
        return dn[: -len(source_base)] + target_base
    return dn


def depth(dn: str) -> int:
    """How deep a distinguished name is, so parents are created first."""
    return dn.count(",")


async def replace_table(
    conn: asyncpg.Connection, table: str, rows: list[dict[str, Any]]
) -> int:
    """Put a table back exactly as the export found it.

    Emptied first: an import is "make this domain the one in the file", and a
    row left behind from before is a setting nobody in the new domain ever
    chose. Columns the running schema does not have are dropped, so a file
    from an older version still imports — the settings it never carried keep
    the defaults this version gives them.
    """
    known = {
        record["column_name"]
        for record in await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = $1",
            table,
        )
    }
    if not known:
        return 0
    await conn.execute(f'DELETE FROM "{table}"')  # noqa: S608 - name from the schema
    written = 0
    for row in rows:
        columns = [name for name in row if name in known and row[name] != WITHHELD]
        if not columns:
            continue
        values = [_restore(row[name]) for name in columns]
        placeholders = ", ".join(f"${index + 1}" for index in range(len(columns)))
        names = ", ".join(f'"{name}"' for name in columns)
        await conn.execute(
            f'INSERT INTO "{table}" ({names}) VALUES ({placeholders})',  # noqa: S608
            *values,
        )
        written += 1
    return written


def as_json(document: dict[str, Any]) -> str:
    """The file itself: indented, because somebody reads it."""
    return json.dumps(document, indent=2, sort_keys=False, default=str) + "\n"
