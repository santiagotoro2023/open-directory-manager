"""A terminal on a machine, joined here between the console and the agent.

The one-shot shell (`/computer/shell`) runs a command and returns what it
printed. This is the other thing: a pseudo-terminal on the machine with a
login shell on it, its bytes carried both ways, and the console's own
terminal emulator at the near end — a session, not a request.

Neither end can reach the other directly: the browser has the console and
the agent dials the console, so the console is where the two meet. A session
is asked for over the ordinary API (which is where the right to have one is
checked and the request recorded), the agent is told to connect by a queued
task, and each end then opens a WebSocket here. This module holds the
sessions between those two connections, joins them, keeps the transcript,
and says when it is over.

Everything an operator types and everything the machine printed is kept and
written to the audit log when the session ends. A root shell on a machine is
the widest power the console hands out; the record of it is what makes it
acceptable to hand out at all.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

# The first byte of every message, at every end. 0 is terminal bytes; 1 is a
# small JSON object — a resize from the console, an exit from the agent.
FRAME_DATA = 0
FRAME_CONTROL = 1

# How much of a session is kept for the audit log. The most recent part: it
# is the end of a session that says what happened, and a transcript that
# scrolled a log file past is not what anyone reads back.
TRANSCRIPT_BYTES = 256 * 1024

# How long the console waits for the agent to connect once asked. The agent
# holds a request open and starts a task within about a second; anything past
# this is a machine that is off, or an agent too old to know what was asked.
AGENT_WAIT_SECONDS = 25

# A session nobody has typed into for this long is over. Long enough for a
# build to finish while somebody watches; not so long that a forgotten tab
# leaves a root shell open for a day.
IDLE_SECONDS = 30 * 60
LONGEST_SECONDS = 8 * 3600


@dataclass
class Terminal:
    id: str
    dn: str
    hostname: str
    # The console session that asked. Only that one may connect a terminal.
    admin_session_id: str
    principal: str
    principal_sid: str
    source_ip: str | None
    cols: int
    rows: int
    started_at: float = field(default_factory=time.monotonic)
    to_agent: asyncio.Queue[bytes | None] = field(default_factory=asyncio.Queue)
    to_console: asyncio.Queue[bytes | None] = field(default_factory=asyncio.Queue)
    agent_joined: asyncio.Event = field(default_factory=asyncio.Event)
    closed: asyncio.Event = field(default_factory=asyncio.Event)
    transcript: bytearray = field(default_factory=bytearray)
    typed: bytearray = field(default_factory=bytearray)
    last_input: float = field(default_factory=time.monotonic)
    exit_status: int | None = None
    reason: str = ""
    # Whether the record has been written. Whichever end sees the close first
    # writes it; the other finds it done.
    recorded: bool = False

    def note_output(self, data: bytes) -> None:
        self.transcript.extend(data)
        if len(self.transcript) > TRANSCRIPT_BYTES:
            del self.transcript[: len(self.transcript) - TRANSCRIPT_BYTES]

    def note_input(self, data: bytes) -> None:
        self.last_input = time.monotonic()
        self.typed.extend(data)
        if len(self.typed) > TRANSCRIPT_BYTES:
            del self.typed[: len(self.typed) - TRANSCRIPT_BYTES]

    def close(self, reason: str) -> None:
        """End the session. Idempotent; the first reason is the one kept."""
        if self.closed.is_set():
            return
        self.reason = reason
        self.closed.set()
        # Wake whichever loops are waiting on a queue.
        self.to_agent.put_nowait(None)
        self.to_console.put_nowait(None)

    @property
    def seconds(self) -> int:
        return int(time.monotonic() - self.started_at)

    def idle_for(self) -> float:
        return time.monotonic() - self.last_input

    def record(self) -> dict[str, Any] | None:
        """What goes in the audit log, once."""
        if self.recorded:
            return None
        self.recorded = True
        return {
            "seconds": self.seconds,
            "exit_status": self.exit_status,
            "reason": self.reason,
            "typed": self.typed.decode("utf-8", "replace")[-64_000:],
            "transcript": self.transcript.decode("utf-8", "replace")[-64_000:],
        }


class Registry:
    """The sessions between being asked for and being over."""

    def __init__(self) -> None:
        self._sessions: dict[str, Terminal] = {}

    def create(
        self,
        *,
        dn: str,
        hostname: str,
        admin_session_id: str,
        principal: str,
        principal_sid: str,
        source_ip: str | None,
        cols: int,
        rows: int,
    ) -> Terminal:
        self._sweep()
        term = Terminal(
            id=secrets.token_urlsafe(24),
            dn=dn,
            hostname=hostname,
            admin_session_id=admin_session_id,
            principal=principal,
            principal_sid=principal_sid,
            source_ip=source_ip,
            cols=cols,
            rows=rows,
        )
        self._sessions[term.id] = term
        return term

    def get(self, session_id: str) -> Terminal | None:
        return self._sessions.get(session_id)

    def forget(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def open_for(self, dn: str) -> list[Terminal]:
        return [s for s in self._sessions.values() if s.dn == dn and not s.closed.is_set()]

    def _sweep(self) -> None:
        """Drop what ended a while ago and was never collected."""
        for session_id, term in list(self._sessions.items()):
            if term.closed.is_set() and term.recorded:
                self._sessions.pop(session_id, None)
            elif term.seconds > LONGEST_SECONDS:
                term.close("the session reached its longest allowed length")


registry = Registry()


def control(**fields: Any) -> bytes:
    """One control frame."""
    return bytes([FRAME_CONTROL]) + json.dumps(fields).encode()


def parse_control(message: bytes) -> dict[str, Any] | None:
    if not message or message[0] != FRAME_CONTROL:
        return None
    try:
        parsed = json.loads(message[1:].decode("utf-8", "replace"))
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


async def watchdog(term: Terminal) -> None:
    """Ends a session nobody is using, or one that has gone on too long."""
    with contextlib.suppress(asyncio.CancelledError):
        while not term.closed.is_set():
            await asyncio.sleep(30)
            if term.idle_for() > IDLE_SECONDS:
                term.close("nothing typed for half an hour")
            elif term.seconds > LONGEST_SECONDS:
                term.close("the session reached its longest allowed length")


async def finish(pool: Any, term: Terminal) -> None:
    """Write the record of a session that has ended, once.

    Two rows: the audit log, with the transcript, which is the account of
    what was done; and the machine's own activity, so a root shell opened
    from here sits in the same list as a sudo command typed at the machine —
    which is what it is.
    """
    from . import audit  # noqa: PLC0415  (audit imports nothing of this module)

    record = term.record()
    if record is None:
        return
    summary = f"{term.hostname}: {record['seconds']}s"
    if record["exit_status"] is not None:
        summary += f", exit {record['exit_status']}"
    if record["reason"]:
        summary += f" ({record['reason']})"
    async with pool.acquire() as conn:
        await audit.record(
            conn,
            actor=term.principal,
            actor_sid=term.principal_sid,
            source_ip=term.source_ip,
            action="computer.shell.session",
            outcome="success",
            object_type="computer",
            object_dn=term.dn,
            detail=summary,
            after=record,
        )
        await conn.execute(
            """
            INSERT INTO computer_event
                (computer_dn, hostname, kind, principal, occurred_at, detail, service, source)
            VALUES ($1, $2, 'console-shell', $3, now(), $4, 'console', $5)
            ON CONFLICT (computer_dn, kind, principal, occurred_at) DO NOTHING
            """,
            term.dn,
            term.hostname,
            term.principal,
            summary,
            term.source_ip or "",
        )
