"""What people did on the machines.

The audit log is what was done through the console. This is the other half:
what was done at the machines themselves — who signed in where and how, who
ran what under sudo, who became root, whose phone approved a sign-in and
whose refused one, which password was changed, which local account was
added, what was plugged in. Each machine's agent reads its own journal for
these (agent/internal/inventory/activity.go) and reports them with its
inventory; they land in computer_event, one row each, the same shape
whatever the kind, and this is the one place to ask across all of them.

Read-only. Nothing here writes: the rows come from the machines, and from
the console's own terminal sessions (terminal.py).
"""

from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from .security import Authz, authorization, get_pool

router = APIRouter(prefix="/api/v1/activity", tags=["activity"])

# The kinds, in families, for the filter and for the summary. A kind the
# agent reports that is not listed here is still stored and shown — the
# families are a convenience, not a schema.
FAMILIES: dict[str, tuple[str, ...]] = {
    "sign-ins": (
        "sign-in", "sign-out", "sign-in-failed", "logon", "logoff",
        "logon-hours-refused", "logon-hours-signed-out",
    ),
    "privilege": ("sudo", "sudo-denied", "su", "su-denied", "console-shell"),
    "second-factor": (
        "second-factor-approved",
        "second-factor-denied",
        "second-factor-timeout",
        "second-factor-enrolled",
        "second-factor-removed",
    ),
    "accounts": ("password-changed", "local-user-added", "local-user-removed", "group-changed"),
    "devices": ("usb-connected", "usb-disconnected"),
    "power": ("boot", "shutdown", "update"),
}

# What is worth counting on the overview: the things somebody should look
# at rather than the things that merely happened.
WATCHED = (
    "sign-in-failed", "sudo-denied", "su-denied", "second-factor-denied", "usb-connected",
    "logon-hours-refused",
)

SELECT = """
    SELECT id, computer_dn, hostname, kind, principal, occurred_at, detail, service, source
    FROM computer_event
    WHERE ($1::text IS NULL OR lower(computer_dn) = lower($1))
      AND ($2::text IS NULL OR hostname ILIKE '%' || $2 || '%')
      AND ($3::text IS NULL OR principal ILIKE '%' || $3 || '%')
      AND ($4::text[] IS NULL OR kind = ANY($4))
      AND ($5::text IS NULL OR service = $5)
      AND ($6::timestamptz IS NULL OR occurred_at >= $6)
      AND ($7::timestamptz IS NULL OR occurred_at <= $7)
      AND ($8::text IS NULL OR detail ILIKE '%' || $8 || '%' OR source ILIKE '%' || $8 || '%')
    ORDER BY occurred_at DESC, id DESC
    LIMIT $9 OFFSET $10
"""


def _kinds(kind: str | None) -> list[str] | None:
    """A family name or one kind, as the list the query takes."""
    if not kind:
        return None
    return list(FAMILIES.get(kind, (kind,)))


def _row(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "computer_dn": row["computer_dn"],
        "hostname": row["hostname"],
        "kind": row["kind"],
        "principal": row["principal"],
        "occurred_at": row["occurred_at"],
        "detail": row["detail"] or "",
        "service": row["service"],
        "source": row["source"],
    }


def _gate(authz: Authz, dn: str | None) -> None:
    """One machine's activity comes with reading that machine; everybody's
    at once is the audit right, which is what it is."""
    if dn:
        authz.require("directory.read", dn)
    else:
        authz.require("audit.read")


@router.get("")
async def list_activity(
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    dn: Annotated[str | None, Query(max_length=1024)] = None,
    hostname: Annotated[str | None, Query(max_length=256)] = None,
    principal: Annotated[str | None, Query(max_length=256)] = None,
    kind: Annotated[str | None, Query(max_length=40)] = None,
    service: Annotated[str | None, Query(max_length=32)] = None,
    since: datetime | None = None,
    until: datetime | None = None,
    q: Annotated[str | None, Query(max_length=256)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
) -> dict[str, Any]:
    _gate(authz, dn)
    rows = await pool.fetch(
        SELECT, dn, hostname, principal, _kinds(kind), service, since, until, q, limit, offset
    )
    return {"entries": [_row(row) for row in rows], "limit": limit, "offset": offset}


@router.get("/export")
async def export_activity(
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    dn: Annotated[str | None, Query(max_length=1024)] = None,
    hostname: Annotated[str | None, Query(max_length=256)] = None,
    principal: Annotated[str | None, Query(max_length=256)] = None,
    kind: Annotated[str | None, Query(max_length=40)] = None,
    service: Annotated[str | None, Query(max_length=32)] = None,
    since: datetime | None = None,
    until: datetime | None = None,
    q: Annotated[str | None, Query(max_length=256)] = None,
) -> StreamingResponse:
    """The same list as a CSV, for whoever has to answer a question about it
    somewhere other than here."""
    _gate(authz, dn)
    rows = await pool.fetch(
        SELECT, dn, hostname, principal, _kinds(kind), service, since, until, q, 50_000, 0
    )
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["occurred_at", "hostname", "kind", "principal", "service", "source", "detail"])
    for row in rows:
        writer.writerow(
            [
                row["occurred_at"].isoformat(),
                row["hostname"],
                row["kind"],
                row["principal"],
                row["service"],
                row["source"],
                row["detail"] or "",
            ]
        )
    out.seek(0)
    return StreamingResponse(
        out,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="activity.csv"'},
    )


@router.get("/kinds")
async def known_kinds(
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict[str, Any]:
    """The families, and every kind seen so far — including any the agent
    has started reporting that the families do not name yet."""
    authz.require("audit.read")
    rows = await pool.fetch("SELECT DISTINCT kind FROM computer_event ORDER BY kind")
    return {
        "families": {name: list(kinds) for name, kinds in FAMILIES.items()},
        "kinds": [row["kind"] for row in rows],
    }


@router.get("/summary")
async def summary(
    authz: Authz = Depends(authorization),
    pool: asyncpg.Pool = Depends(get_pool),
    hours: Annotated[int, Query(ge=1, le=24 * 90)] = 24,
    dn: Annotated[str | None, Query(max_length=1024)] = None,
) -> dict[str, Any]:
    """How much of each kind, lately — the numbers the overview shows."""
    _gate(authz, dn)
    rows = await pool.fetch(
        """
        SELECT kind, count(*) AS total, count(DISTINCT hostname) AS machines,
               count(DISTINCT principal) AS people
        FROM computer_event
        WHERE occurred_at > now() - ($1 || ' hours')::interval
          AND ($2::text IS NULL OR lower(computer_dn) = lower($2))
        GROUP BY kind
        ORDER BY kind
        """,
        str(hours),
        dn,
    )
    return {
        "hours": hours,
        "kinds": [
            {
                "kind": row["kind"],
                "total": row["total"],
                "machines": row["machines"],
                "people": row["people"],
            }
            for row in rows
        ],
        "watched": list(WATCHED),
    }
