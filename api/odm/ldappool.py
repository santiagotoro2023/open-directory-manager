"""Bound LDAP connections, kept and reused.

A GSSAPI bind is a round trip to the KDC and another to the directory, and the
console does several searches per page. Binding for every one of them is the
cost that shows up first on a domain of any size.

Connections are handed out one request at a time — ldap3 is not thread-safe —
and are dropped rather than returned when anything goes wrong with them, so a
connection that has been reset never reaches a second request.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from dataclasses import dataclass, field

from fastapi.concurrency import run_in_threadpool
from ldap3 import Connection

from . import directory
from .config import Settings

# How many to keep, per kind. Small: the console is one process serving one
# operator at a time, and a connection nobody is using is a socket the
# directory has to keep open.
POOL_SIZE = 8
# A connection nobody has used for this long is closed rather than checked,
# and one older than the lifetime is replaced whether or not it still works.
IDLE_SECONDS = 300
LIFETIME_SECONDS = 3600


@dataclass
class _Held:
    conn: Connection
    born: float
    used: float


@dataclass
class Pool:
    """Two pools: read-only binds and writable ones, kept apart because the
    connection itself is opened read-only or not."""

    idle: dict[bool, list[_Held]] = field(default_factory=lambda: {True: [], False: []})
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def take(self, settings: Settings, *, write: bool) -> Connection:
        now = time.monotonic()
        async with self.lock:
            held = self.idle[write]
            while held:
                candidate = held.pop()
                if now - candidate.born > LIFETIME_SECONDS or now - candidate.used > IDLE_SECONDS:
                    await _close(candidate.conn)
                    continue
                if candidate.conn.bound:
                    return candidate.conn
                await _close(candidate.conn)
        return await run_in_threadpool(directory.service_connection, settings, read_only=not write)

    async def give_back(self, conn: Connection, *, write: bool, healthy: bool) -> None:
        if not healthy or not conn.bound:
            await _close(conn)
            return
        now = time.monotonic()
        async with self.lock:
            held = self.idle[write]
            if len(held) >= POOL_SIZE:
                await _close(conn)
                return
            held.append(_Held(conn=conn, born=getattr(conn, "_odm_born", now), used=now))

    async def close(self) -> None:
        async with self.lock:
            for held in list(self.idle[True]) + list(self.idle[False]):
                await _close(held.conn)
            self.idle = {True: [], False: []}


async def _close(conn: Connection) -> None:
    # Closing a connection that is already broken is not an error worth
    # reporting: it is being thrown away either way.
    with contextlib.suppress(Exception):
        await run_in_threadpool(conn.unbind)


_pool = Pool()


@contextlib.asynccontextmanager
async def bound(settings: Settings, *, write: bool):
    """A bound connection for the duration of one piece of work."""
    conn = await _pool.take(settings, write=write)
    if not hasattr(conn, "_odm_born"):
        conn._odm_born = time.monotonic()  # noqa: SLF001 - our own bookkeeping
    healthy = True
    try:
        yield conn
    except Exception:
        # Whatever went wrong, this connection is not one to hand to the next
        # request: a search that raised may have left a response half-read.
        healthy = False
        raise
    finally:
        await _pool.give_back(conn, write=write, healthy=healthy)


async def close_all() -> None:
    await _pool.close()
