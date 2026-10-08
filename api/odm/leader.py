"""One replica runs the scheduled work.

The control plane keeps everything in PostgreSQL, so any number of replicas
can answer requests. What it does on a clock is different: the recycle bin's
retention sweep, the scheduled domain backup, the dynamic groups, the
monitoring rules and the password manager's reconciliation each assume they
are the only one doing it. Two replicas each queuing the nightly backup is
two backups; two each evaluating an alert rule is the same alert twice on
somebody's phone.

So the scheduled work runs on whichever replica holds a PostgreSQL advisory
lock, taken on a connection kept for as long as it is held. When that replica
stops — upgraded, rescheduled, killed — its connection closes, PostgreSQL
releases the lock, and another replica takes it within a few seconds. One
replica, which is every host install, takes it at once and nothing changes.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from typing import Any

from .db import SCHEDULER_LOCK

log = logging.getLogger("odm.leader")

# How often a replica without the lock asks for it, and how often the one
# with it checks that the connection holding it is still alive.
RETRY_SECONDS = 10.0
CHECK_SECONDS = 10.0


async def run_while_leader(
    pool: Any,
    start: Callable[[], list[asyncio.Task]],
    *,
    retry_seconds: float = RETRY_SECONDS,
    check_seconds: float = CHECK_SECONDS,
) -> None:
    """Run the tasks start() makes for exactly as long as this replica holds
    the scheduler lock. Never returns; cancel it to stop."""
    while True:
        conn = None
        running: list[asyncio.Task] = []
        try:
            conn = await pool.acquire()
            held = await conn.fetchval("SELECT pg_try_advisory_lock($1)", SCHEDULER_LOCK)
            if not held:
                await pool.release(conn)
                conn = None
                await asyncio.sleep(retry_seconds)
                continue
            log.info("this replica runs the scheduled work")
            running = start()
            while True:
                await asyncio.sleep(check_seconds)
                # A connection that has gone has taken the lock with it, and
                # another replica may already hold it: stop at once.
                await conn.fetchval("SELECT 1")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - the loop must outlive one lost connection
            log.warning("scheduler lock lost or unavailable: %s", exc)
            await asyncio.sleep(retry_seconds)
        finally:
            for task in running:
                task.cancel()
            for task in running:
                with contextlib.suppress(BaseException):
                    await task
            if conn is not None:
                with contextlib.suppress(Exception):
                    await conn.execute("SELECT pg_advisory_unlock($1)", SCHEDULER_LOCK)
                with contextlib.suppress(Exception):
                    await pool.release(conn)
