"""What changed, as it changes.

The console used to be a set of pages that were true when they loaded. An
operator installing a role, creating a share or waiting for a machine to
report had to press refresh to find out whether it had happened.

Postgres is already where every change lands, so it is what says so: a
statement-level trigger on the tables worth watching sends the table's name on
one channel, one connection listens, and every console session with the page
open re-reads what it is showing. The notification carries a table name and
nothing else — each console re-reads with the rights of whoever is looking.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

import asyncpg

CHANNEL = "odm_changed"

# Nobody is watching this many changes a second; anything more is a bulk
# import, and a full queue drops the oldest rather than growing without end.
QUEUE_DEPTH = 64


class Broadcaster:
    """One listening connection, many console sessions."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._connection: asyncpg.Connection | None = None

    async def start(self, pool: asyncpg.Pool) -> None:
        self._connection = await pool.acquire()
        await self._connection.add_listener(CHANNEL, self._on_notify)

    async def stop(self) -> None:
        if self._connection is None:
            return
        with contextlib.suppress(Exception):
            await self._connection.remove_listener(CHANNEL, self._on_notify)
            await self._connection.close()
        self._connection = None

    def _on_notify(self, _conn: Any, _pid: int, _channel: str, payload: str) -> None:
        for queue in list(self._subscribers):
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(payload)

    @contextlib.asynccontextmanager
    async def subscribe(self):
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=QUEUE_DEPTH)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    @property
    def listening(self) -> bool:
        return self._connection is not None


broadcaster = Broadcaster()
