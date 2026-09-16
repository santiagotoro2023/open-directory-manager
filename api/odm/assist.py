"""Somebody's screen, watched from the console — the bridge in the middle.

Remote assistance used to end with an address and a one-time password that an
administrator then typed into a VNC viewer of their own, if they had one
installed, if it reached the machine, if it liked the password. The person on
the phone waited through all of that. Now the console is the viewer: the
machine's VNC server listens on its own loopback only, the agent carries its
bytes here over the same outbound, Kerberos-authenticated WebSocket path the
terminal uses, and a page in the console speaks RFB to it. Nothing on the
machine is opened to the network, and the administrator clicks once.

This module holds an offer between the moment the person says yes and the
moment it expires, and joins the agent's connection to the console's. The
agent connects as soon as sharing is up and waits; a viewer page attaching
tells it to open the local VNC port, and when the page goes away the agent
hangs up and connects again, ready for the next tab, until the offer runs
out. The bytes are the VNC protocol as the server and the viewer speak it,
carried untouched — the console never interprets them.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

# How long the console waits for the agent to be on the line once a viewer
# attaches. The agent connects the moment sharing starts, so this only elapses
# when the agent could not reach the console at all.
AGENT_WAIT_SECONDS = 25


@dataclass
class Link:
    """One connection from the agent: waiting, then carrying one viewer."""

    to_agent: asyncio.Queue[bytes | str | None] = field(default_factory=asyncio.Queue)
    to_console: asyncio.Queue[bytes | None] = field(default_factory=asyncio.Queue)
    # Set when a viewer has taken this link; a second viewer waits for the
    # agent's next connection rather than sharing the stream.
    taken: bool = False
    closed: asyncio.Event = field(default_factory=asyncio.Event)

    def close(self) -> None:
        if self.closed.is_set():
            return
        self.closed.set()
        self.to_agent.put_nowait(None)
        self.to_console.put_nowait(None)


@dataclass
class Offer:
    id: str
    dn: str
    hostname: str
    username: str
    # The console session that asked; only its viewer pages may attach.
    admin_session_id: str
    principal: str
    principal_sid: str
    source_ip: str | None
    minutes: int
    protocol: str = ""
    password: str = ""
    created_at: float = field(default_factory=time.monotonic)
    # Nothing until the agent connects; replaced each time it reconnects.
    link: Link | None = None
    link_arrived: asyncio.Event = field(default_factory=asyncio.Event)
    ended: asyncio.Event = field(default_factory=asyncio.Event)
    views: int = 0

    @property
    def seconds_left(self) -> int:
        return max(0, int(self.minutes * 60 - (time.monotonic() - self.created_at)))

    @property
    def expired(self) -> bool:
        return self.seconds_left <= 0 or self.ended.is_set()

    def offer_link(self, link: Link) -> None:
        """A fresh agent connection, ready for a viewer."""
        self.link = link
        self.link_arrived.set()

    def take_link(self) -> Link | None:
        """The waiting agent connection, for one viewer; None when none is
        free, in which case the caller waits for the next arrival."""
        link = self.link
        if link is None or link.taken or link.closed.is_set():
            self.link_arrived.clear()
            return None
        link.taken = True
        self.link_arrived.clear()
        return link

    def end(self) -> None:
        self.ended.set()
        if self.link is not None:
            self.link.close()


class Registry:
    def __init__(self) -> None:
        self._offers: dict[str, Offer] = {}

    def create(
        self,
        *,
        dn: str,
        hostname: str,
        username: str,
        admin_session_id: str,
        principal: str,
        principal_sid: str,
        source_ip: str | None,
        minutes: int,
    ) -> Offer:
        self._sweep()
        offer = Offer(
            id=secrets.token_urlsafe(24),
            dn=dn,
            hostname=hostname,
            username=username,
            admin_session_id=admin_session_id,
            principal=principal,
            principal_sid=principal_sid,
            source_ip=source_ip,
            minutes=minutes,
        )
        self._offers[offer.id] = offer
        return offer

    def get(self, offer_id: str) -> Offer | None:
        offer = self._offers.get(offer_id)
        if offer is not None and offer.expired:
            offer.end()
            self._offers.pop(offer_id, None)
            return None
        return offer

    def forget(self, offer_id: str) -> None:
        offer = self._offers.pop(offer_id, None)
        if offer is not None:
            offer.end()

    def _sweep(self) -> None:
        for offer_id, offer in list(self._offers.items()):
            if offer.expired:
                offer.end()
                self._offers.pop(offer_id, None)


registry = Registry()


async def record_view(pool: Any, offer: Offer, seconds: int, reason: str) -> None:
    """One viewing, in the audit log and the machine's own activity: who
    watched whose screen, from where, for how long."""
    from . import audit  # noqa: PLC0415

    summary = f"{offer.hostname}: watched {offer.username}'s screen for {seconds}s ({reason})"
    async with pool.acquire() as conn:
        await audit.record(
            conn,
            actor=offer.principal,
            actor_sid=offer.principal_sid,
            source_ip=offer.source_ip,
            action="computer.assist.view",
            outcome="success",
            object_type="computer",
            object_dn=offer.dn,
            detail=summary,
            after={"user": offer.username, "seconds": seconds, "reason": reason},
        )
        await conn.execute(
            """
            INSERT INTO computer_event
                (computer_dn, hostname, kind, principal, occurred_at, detail, service, source)
            VALUES ($1, $2, 'console-assist', $3, now(), $4, 'console', $5)
            ON CONFLICT (computer_dn, kind, principal, occurred_at) DO NOTHING
            """,
            offer.dn,
            offer.hostname,
            offer.principal,
            summary,
            offer.source_ip or "",
        )
