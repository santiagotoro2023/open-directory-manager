"""Terminals and shared screens across replicas of the control plane.

A terminal (terminal.py) or a shared screen (assist.py) is two WebSockets
joined in the memory of one process: the console's, and the agent's. With one
replica that is the only process there is. With several behind one address,
the console's socket, the agent's socket and the request that asked for the
session each land wherever the load balancer sends them, and a session held
in one replica's memory is "not found" on every other.

So a replica that is one of several (ODM_REPLICA_URL set) registers the
address the others reach it at, and every session it opens carries that
registration's number in front of its id: "7.<random>". Any replica handed a
socket, or the viewer's one request, for a session that is not its own
carries it across to the replica that holds it, untouched, credentials and
all — the owner authenticates it exactly as if it had arrived there first.
Nothing is trusted because it came from a peer: the peer only ever forwards.

The hop between replicas is TLS, verified against the console's own
certificate, which every replica presents.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import secrets
import ssl
from typing import Any
from urllib.parse import urlsplit

from .config import Settings, get_settings

log = logging.getLogger("odm.replicas")

# This replica's registration, when it is one of several.
_self_id: int | None = None
# Registrations of the others, as they are looked up.
_known: dict[int, str] = {}
_pool: Any = None

# Every path that names a session held in memory. The id is the last segment.
_SOCKETS = re.compile(
    r"^/api/v1/(?:servers/computer/(?:shell|assist)/session|agent/(?:shell|assist))/"
    r"(?P<owner>\d{1,9})\.[A-Za-z0-9_-]{8,64}$"
)
_REQUESTS = re.compile(
    r"^/api/v1/servers/computer/assist/session/(?P<owner>\d{1,9})\.[A-Za-z0-9_-]{8,64}$"
)

# What is carried across with a forwarded request: what the owner checks.
_FORWARDED_HEADERS = ("cookie", "origin", "authorization", "user-agent", "accept")
# What is not carried back: it describes the hop between replicas.
_HOP_HEADERS = frozenset(
    ("connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding",
     "server", "date")
)


async def register(pool: Any, settings: Settings) -> None:
    """Record where this replica can be reached. Nothing, for one replica."""
    global _self_id, _pool
    _pool = pool
    if not settings.replica_url:
        _self_id = None
        return
    _self_id = await pool.fetchval(
        """
        INSERT INTO control_plane_replica (url) VALUES ($1)
        ON CONFLICT (url) DO UPDATE SET seen_at = now()
        RETURNING id
        """,
        settings.replica_url,
    )
    _known[_self_id] = settings.replica_url
    log.info("replica %s at %s", _self_id, settings.replica_url)


def new_session_id() -> str:
    """An id for a session held in this replica's memory."""
    token = secrets.token_urlsafe(24)
    return f"{_self_id}.{token}" if _self_id is not None else token


def owner_of(path: str, websocket: bool) -> int | None:
    """The replica a request for this path belongs to, if it is another one."""
    if _self_id is None:
        return None
    match = (_SOCKETS if websocket else _REQUESTS).match(path)
    if match is None:
        return None
    owner = int(match.group("owner"))
    return None if owner == _self_id else owner


async def _url_of(owner: int) -> str | None:
    if owner in _known:
        return _known[owner]
    if _pool is None:
        return None
    url = await _pool.fetchval("SELECT url FROM control_plane_replica WHERE id = $1", owner)
    if url:
        _known[owner] = url
    return url


def tls_context(settings: Settings) -> ssl.SSLContext:
    """Trust exactly the certificate this console presents.

    Every replica serves the same certificate from the volume they share, so
    a peer that can present it holds the console's key. Partial chains, so a
    certificate the domain's authority issued is trusted as itself.
    """
    context = ssl.create_default_context(cafile=str(settings.tls_dir / "api.crt"))
    context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    return context


def console_host(settings: Settings) -> str:
    return urlsplit(settings.console_url).hostname or ""


def _headers(scope: dict) -> list[tuple[str, str]]:
    found = []
    for raw_name, raw_value in scope.get("headers", []):
        name = raw_name.decode("latin-1").lower()
        if name in _FORWARDED_HEADERS:
            found.append((name, raw_value.decode("latin-1")))
    return found


class ReplicaForwarder:
    """ASGI middleware: carry a request for another replica's session to it."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        kind = scope.get("type")
        if kind not in ("http", "websocket") or _self_id is None:
            await self.app(scope, receive, send)
            return
        owner = owner_of(scope.get("path", ""), websocket=kind == "websocket")
        if owner is None or (kind == "http" and scope.get("method") != "GET"):
            await self.app(scope, receive, send)
            return
        url = await _url_of(owner)
        if url is None:
            # Not a replica anyone has heard of: let the route say not found.
            await self.app(scope, receive, send)
            return
        settings = get_settings()
        if kind == "websocket":
            await _forward_socket(scope, receive, send, url, settings)
        else:
            await _forward_request(scope, send, url, settings)


async def _forward_request(scope: dict, send: Any, base: str, settings: Settings) -> None:
    import httpx

    query = scope.get("query_string", b"").decode("latin-1")
    target = f"{base}{scope['path']}" + (f"?{query}" if query else "")
    try:
        async with httpx.AsyncClient(verify=tls_context(settings), timeout=15) as client:
            response = await client.get(
                target,
                headers=_headers(scope),
                extensions={"sni_hostname": console_host(settings)},
            )
        status, body = response.status_code, response.content
        # The owner's own headers — its security headers among them — less
        # what describes the hop rather than the answer.
        headers = [
            (name.encode("latin-1"), value.encode("latin-1"))
            for name, value in response.headers.multi_items()
            if name.lower() not in _HOP_HEADERS
        ]
    except httpx.HTTPError as exc:
        log.warning("replica at %s did not answer: %s", base, exc)
        status, body = 404, b'{"detail":"this offer has ended"}'
        headers = [(b"content-type", b"application/json")]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


async def _forward_socket(
    scope: dict, receive: Any, send: Any, base: str, settings: Settings
) -> None:
    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed, InvalidStatus

    first = await receive()
    if first.get("type") != "websocket.connect":
        return
    query = scope.get("query_string", b"").decode("latin-1")
    target = base.replace("https://", "wss://", 1) + scope["path"] + (f"?{query}" if query else "")
    headers = _headers(scope)
    origin = next((value for name, value in headers if name == "origin"), None)
    extra = [(name, value) for name, value in headers if name != "origin"]
    subprotocols = list(scope.get("subprotocols") or []) or None
    try:
        upstream = await connect(
            target,
            ssl=tls_context(settings),
            server_hostname=console_host(settings),
            additional_headers=extra,
            origin=origin,  # type: ignore[arg-type]
            subprotocols=subprotocols,  # type: ignore[arg-type]
            max_size=None,
            open_timeout=15,
            ping_interval=None,
        )
    except (TimeoutError, InvalidStatus, OSError) as exc:
        log.warning("replica at %s refused or did not answer: %s", base, exc)
        # The same refusal the route itself gives for a session it does not hold.
        await send({"type": "websocket.close", "code": 4404})
        return

    accept: dict[str, Any] = {"type": "websocket.accept"}
    if upstream.subprotocol:
        accept["subprotocol"] = upstream.subprotocol
    await send(accept)

    async def downstream() -> None:
        while True:
            message = await receive()
            if message["type"] == "websocket.disconnect":
                return
            if message.get("bytes") is not None:
                await upstream.send(message["bytes"])
            elif message.get("text") is not None:
                await upstream.send(message["text"])

    async def from_owner() -> None:
        with contextlib.suppress(ConnectionClosed):
            async for message in upstream:
                if isinstance(message, bytes):
                    await send({"type": "websocket.send", "bytes": message})
                else:
                    await send({"type": "websocket.send", "text": message})

    down = asyncio.create_task(downstream())
    up = asyncio.create_task(from_owner())
    try:
        await asyncio.wait({down, up}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in (down, up):
            task.cancel()
            with contextlib.suppress(BaseException):
                await task
        code = upstream.close_code or 1000
        with contextlib.suppress(Exception):
            await upstream.close()
        with contextlib.suppress(Exception):
            await send({"type": "websocket.close", "code": code})
