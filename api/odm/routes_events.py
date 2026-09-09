"""The stream the console listens to, so its pages stay true without a reload."""

from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from . import events
from .security import require_admin
from .sessions import Session

router = APIRouter(prefix="/api/v1", tags=["events"])

# Long enough not to be chatty, short enough that a proxy which drops idle
# connections is noticed and reconnected to rather than sitting silent.
HEARTBEAT_SECONDS = 20


@router.get("/events")
async def stream(request: Request, session: Session = Depends(require_admin)) -> StreamingResponse:
    """Server-sent events: one line per table that changed.

    A name, never the change itself. Every console re-reads what it is showing
    with the rights of whoever is signed in to it, so this stream tells nobody
    anything they could not already ask for.
    """

    async def lines():
        async with events.broadcaster.subscribe() as queue:
            yield f": watching as {session.principal}\n\n"
            while True:
                if await request.is_disconnected():
                    return
                try:
                    table = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except TimeoutError:
                    yield ": still here\n\n"
                    continue
                with contextlib.suppress(Exception):
                    yield f"data: {json.dumps({'table': table})}\n\n"

    return StreamingResponse(
        lines(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            # A proxy that buffers this shows nothing until it decides to
            # flush, which is the same as not having it.
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
