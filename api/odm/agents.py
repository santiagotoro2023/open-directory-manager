"""When each machine's agent was last heard from.

An agent posts a Resultant-Set-of-Policy report only on a run that applied
something: policy it has already applied is not applied again, so a machine
whose policy has not changed in a week posts no report in that week. It does
keep checking in — it reports its inventory and collects queued work on every
pass — so a machine that is plainly alive looked like one that had never run
the agent at all, and the console said so: "has never reported in, so it is
probably not running the agent" over a machine reporting its inventory every
fifteen minutes.

Liveness is therefore the most recent contact of any kind, and the last policy
run is reported next to it rather than in place of it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import asyncpg


@dataclass(frozen=True)
class Contact:
    """The last time one machine's agent was heard from, and how."""

    at: datetime
    how: str
    policy_run: datetime | None


# Every table an agent writes to as itself. A task claim counts: only the
# machine the work is for can claim it, and it claims with its own ticket.
_CONTACT = """
SELECT computer_dn, max(at) AS at, (array_agg(source ORDER BY at DESC))[1] AS how,
       max(policy_run) AS policy_run
FROM (
    SELECT computer_dn, reported_at AS at, 'policy report' AS source,
           reported_at AS policy_run
    FROM agent_report
    UNION ALL
    SELECT computer_dn, reported_at, 'inventory', NULL FROM computer_fact
    UNION ALL
    SELECT computer_fact.computer_dn, node_task.claimed_at, 'queued work', NULL
    FROM node_task
    JOIN computer_fact ON lower(computer_fact.hostname) = lower(node_task.node_fqdn)
    WHERE node_task.claimed_at IS NOT NULL
) AS contact
GROUP BY computer_dn
"""


async def last_contact(pool: asyncpg.Pool) -> dict[str, Contact]:
    """Keyed by lower-cased distinguished name, which is how the directory
    side of every page identifies a machine."""
    rows = await pool.fetch(_CONTACT)
    return {
        row["computer_dn"].lower(): Contact(
            at=row["at"], how=row["how"], policy_run=row["policy_run"]
        )
        for row in rows
        if row["at"] is not None
    }


async def freshness(pool: asyncpg.Pool, stale_after_minutes: int) -> dict[str, int]:
    """How many machines have an agent, and how many were heard from lately.

    The same contact rule as last_contact: a machine applying nothing because
    nothing changed is not a machine that has gone quiet.
    """
    contacts = await last_contact(pool)
    cutoff = datetime.now(UTC) - timedelta(minutes=stale_after_minutes)
    fresh = sum(1 for contact in contacts.values() if contact.at > cutoff)
    return {"checked_in": len(contacts), "fresh": fresh, "stale": len(contacts) - fresh}


def describe(contact: Contact | None) -> dict[str, object]:
    """The three fields every page showing a machine's agent renders."""
    if contact is None:
        return {"last_seen": None, "last_seen_how": "", "last_policy_run": None}
    return {
        "last_seen": contact.at,
        "last_seen_how": contact.how,
        "last_policy_run": contact.policy_run,
    }
