"""The vault, under the console's own address.

The password-manager role runs Vaultwarden on a member server, but nobody
is told that server's name: the vault is https://<console>/vault, one
address and one certificate for the whole domain, and the console carries
every request there — the web vault's pages, the extension's API calls,
the notification socket — over TLS to the node, checked against the
domain's authority. That is why the role needs the certificate authority:
the console will not forward a person's vault traffic to a server it
cannot verify.

Nothing here reads or decides anything about what passes through; the
vault does its own authentication (through the console's OpenID provider),
and its own CORS for the extensions, which is why these paths are kept out
of the console's origin and CORS gates in main.py.
"""

from __future__ import annotations

import asyncio
import logging
import ssl
from typing import Any

import asyncpg
import httpx
import websockets
from fastapi import APIRouter, Depends, Request, WebSocket, status
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.background import BackgroundTask
from starlette.websockets import WebSocketDisconnect

from . import ca
from .config import Settings, get_settings
from .security import get_pool

log = logging.getLogger(__name__)

router = APIRouter(tags=["vault"])

PREFIX = "/vault"
VAULT_PORT = 8222

# Hop-by-hop and connection-level headers, never forwarded either way.
_SKIP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
    "trailer", "transfer-encoding", "upgrade", "host", "content-length",
})

_clients: dict[str, httpx.AsyncClient] = {}


def vault_url(settings: Settings) -> str:
    return settings.console_url.rstrip("/") + PREFIX


async def node(pool: asyncpg.Pool) -> str:
    return await pool.fetchval(
        "SELECT node_fqdn FROM server_role WHERE role_name = 'password-manager'"
        " AND state = 'active' ORDER BY updated_at DESC LIMIT 1"
    ) or ""


def _client(settings: Settings) -> httpx.AsyncClient:
    verify = str(ca.cert_path(settings))
    client = _clients.get(verify)
    if client is None:
        client = httpx.AsyncClient(verify=verify, timeout=httpx.Timeout(60.0, connect=10.0))
        _clients[verify] = client
    return client


def _unavailable(reason: str) -> Response:
    return JSONResponse(
        {"detail": reason}, status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        headers={"Retry-After": "30"},
    )


@router.get(PREFIX, include_in_schema=False)
async def vault_root() -> Response:
    return RedirectResponse(PREFIX + "/", status_code=307)


@router.api_route(
    PREFIX + "/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    include_in_schema=False,
)
async def vault(
    path: str,
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> Response:
    target = await node(pool)
    if not target:
        return _unavailable("the password-manager role is not installed")
    if not ca.initialised(settings):
        return _unavailable("the vault needs the domain's certificate authority")
    url = f"https://{target}:{VAULT_PORT}{PREFIX}/{path}"
    if request.url.query:
        url += "?" + request.url.query
    headers: dict[str, str] = {
        k: v for k, v in request.headers.items() if k.lower() not in _SKIP
    }
    headers["host"] = request.headers.get("host", "")
    headers["x-forwarded-proto"] = "https"
    headers["x-forwarded-host"] = request.headers.get("host", "")
    if request.client:
        headers["x-real-ip"] = request.client.host
        forwarded = request.headers.get("x-forwarded-for")
        headers["x-forwarded-for"] = (
            f"{forwarded}, {request.client.host}" if forwarded else request.client.host
        )
    client = _client(settings)
    upstream_request = client.build_request(
        request.method, url, headers=headers, content=request.stream()
    )
    try:
        upstream = await client.send(upstream_request, stream=True)
    except httpx.HTTPError as exc:
        log.warning("vault at %s unreachable: %s", target, exc)
        return _unavailable("the vault cannot be reached")
    response_headers = {
        k: v for k, v in upstream.headers.multi_items() if k.lower() not in _SKIP
    }
    # The console shows the vault in a frame of its own page: same origin,
    # so the vault's own frame-ancestors 'self' allows it, and this must not
    # be tightened to DENY by the console's defaults.
    response_headers["X-Frame-Options"] = "SAMEORIGIN"
    return StreamingResponse(
        upstream.aiter_raw(), status_code=upstream.status_code, headers=response_headers,
        background=BackgroundTask(upstream.aclose),
    )


@router.websocket(PREFIX + "/notifications/hub")
@router.websocket(PREFIX + "/notifications/anonymous-hub")
async def vault_socket(
    websocket: WebSocket,
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> None:
    """The vault's live-update socket, carried the same way."""
    target = await node(pool)
    if not target or not ca.initialised(settings):
        await websocket.close(code=1013)
        return
    url = f"wss://{target}:{VAULT_PORT}{websocket.url.path}"
    if websocket.url.query:
        url += "?" + websocket.url.query
    context = ssl.create_default_context(cafile=str(ca.cert_path(settings)))
    headers = {
        k: v for k, v in websocket.headers.items()
        if k.lower() not in _SKIP and not k.lower().startswith("sec-websocket")
    }
    try:
        upstream = await websockets.connect(
            url, ssl=context, additional_headers=headers, max_size=None, open_timeout=10
        )
    except (OSError, websockets.exceptions.WebSocketException) as exc:
        log.warning("vault socket at %s unreachable: %s", target, exc)
        await websocket.close(code=1013)
        return
    await websocket.accept()

    async def downstream() -> None:
        async for message in upstream:
            if isinstance(message, bytes):
                await websocket.send_bytes(message)
            else:
                await websocket.send_text(message)

    async def upstream_pump() -> None:
        while True:
            message: dict[str, Any] = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            if message.get("bytes") is not None:
                await upstream.send(message["bytes"])
            elif message.get("text") is not None:
                await upstream.send(message["text"])

    tasks = [asyncio.create_task(downstream()), asyncio.create_task(upstream_pump())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        for task in tasks:
            task.cancel()
        await upstream.close()
        try:
            await websocket.close()
        except RuntimeError:
            pass
