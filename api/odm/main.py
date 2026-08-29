"""FastAPI application.

Phase 1 exposes authentication and health only. Directory, policy, DNS and
DHCP routers arrive in later phases (CLAUDE.md §7).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import (
    auth,
    backup,
    ca,
    db,
    directory,
    dns,
    enrolment,
    kea,
    objects,
    printers,
    roles,
    routes_admx,
    routes_agent,
    routes_audit,
    routes_ca,
    routes_dc,
    routes_dhcp,
    routes_directory,
    routes_dns,
    routes_join,
    routes_operations,
    routes_policy,
    routes_printers,
    routes_rbac,
    routes_recyclebin,
    routes_roles,
    routes_servers,
    routes_shares,
    routes_vpn,
    shares,
    vpn,
)
from .config import Settings, get_settings
from .security import CSRF_HEADER, SecurityHeadersMiddleware

log = logging.getLogger("odm")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    if settings.keytab is not None:
        # Acceptor creds for SPNEGO, and initiator creds for ODM's own
        # read-only LDAP binds, both come from this keytab.
        os.environ.setdefault("KRB5_KTNAME", str(settings.keytab))
        os.environ.setdefault("KRB5_CLIENT_KTNAME", str(settings.keytab))
    app.state.pool = await db.create_pool()
    await _check_directory(settings)
    # The recycle bin's retention window is only real if something enforces
    # it, so the sweep runs with the application (CLAUDE.md §5.3).
    background = [
        asyncio.create_task(routes_recyclebin.purge_loop(app.state.pool)),
        asyncio.create_task(routes_operations.backup_loop(app.state.pool, settings)),
    ]
    try:
        yield
    finally:
        for task in background:
            task.cancel()
        for task in background:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await app.state.pool.close()


async def _check_directory(settings: Settings) -> None:
    """Bind to the directory once at startup and say so either way.

    Everything past the sign-in page needs this bind, so a broken service
    account is a dead console — but it only ever showed up as a 503 with the
    reason discarded. Not fatal: the API has to keep running to be told off.
    """

    def probe() -> None:
        directory.service_connection(settings).unbind()

    try:
        await asyncio.to_thread(probe)
    except Exception as exc:  # noqa: BLE001 - reported, never raised
        log.error("directory bind failed, so nobody will be able to sign in: %s", exc)
        log.error("keytab %s, realm %s", settings.keytab, settings.realm)
    else:
        log.info("directory bind ok: %s", settings.ldap_uri)


def _problem(status_code: int):
    async def handler(_: Request, exc: Exception) -> JSONResponse:
        # Directory errors carry operator-facing detail (which attribute is
        # not editable, which object is protected); never a stack trace.
        return JSONResponse({"detail": str(exc)}, status_code=status_code)

    return handler


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Open Directory Manager API",
        version="0.1.0",
        lifespan=lifespan,
        # No interactive docs in production: the schema is an attack map.
        docs_url=None,
        redoc_url=None,
    )
    app.add_middleware(SecurityHeadersMiddleware)
    if settings.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.allowed_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Content-Type", "Authorization", CSRF_HEADER],
        )
    app.include_router(auth.router)
    app.include_router(routes_directory.router)
    app.include_router(routes_policy.router)
    app.include_router(routes_admx.router)
    app.include_router(routes_agent.router)
    app.include_router(routes_dns.router)
    app.include_router(routes_dhcp.router)
    app.include_router(routes_recyclebin.router)
    app.include_router(routes_roles.router)
    app.include_router(routes_servers.router)
    app.include_router(routes_shares.router)
    app.include_router(routes_printers.router)
    app.include_router(routes_vpn.router)
    app.include_router(routes_dc.router)
    app.include_router(routes_rbac.router)
    app.include_router(routes_ca.router)
    app.include_router(routes_operations.router)
    app.include_router(routes_join.router)
    app.include_router(routes_audit.router)

    # Directory failures map to HTTP once, here, instead of a try/except in
    # every route.
    for exception, code in (
        (objects.NotFound, status.HTTP_404_NOT_FOUND),
        (objects.ProtectedObject, status.HTTP_409_CONFLICT),
        (objects.ObjectError, status.HTTP_400_BAD_REQUEST),
        (directory.NotAuthorized, status.HTTP_403_FORBIDDEN),
        (directory.DirectoryError, status.HTTP_503_SERVICE_UNAVAILABLE),
        (dns.DnsUnavailable, status.HTTP_501_NOT_IMPLEMENTED),
        (dns.DnsError, status.HTTP_400_BAD_REQUEST),
        (kea.KeaUnavailable, status.HTTP_501_NOT_IMPLEMENTED),
        (kea.KeaError, status.HTTP_502_BAD_GATEWAY),
        (backup.BackupError, status.HTTP_400_BAD_REQUEST),
        (enrolment.EnrolmentError, status.HTTP_400_BAD_REQUEST),
        (roles.RoleError, status.HTTP_400_BAD_REQUEST),
        (shares.ShareError, status.HTTP_400_BAD_REQUEST),
        (printers.PrinterError, status.HTTP_400_BAD_REQUEST),
        (vpn.VpnError, status.HTTP_400_BAD_REQUEST),
        (ca.CaNotInitialised, status.HTTP_501_NOT_IMPLEMENTED),
        (ca.CaError, status.HTTP_400_BAD_REQUEST),
    ):
        app.add_exception_handler(exception, _problem(code))

    @app.get("/api/v1/healthz", tags=["health"])
    async def healthz() -> dict[str, str]:
        async with app.state.pool.acquire() as conn:
            await conn.execute("SELECT 1")
        return {"status": "ok", "domain": settings.domain}

    _serve_console(app, settings)
    return app


def _serve_console(app: FastAPI, settings: Settings) -> None:
    """Serve the built console from the same origin as the API.

    Mounted after every API route, so nothing under /api is shadowed. Unknown
    paths return the application shell, because the console routes on the
    client side.
    """
    if settings.console_dir is None:
        return
    root = Path(settings.console_dir)
    index = root / "index.html"
    if not index.is_file():
        raise RuntimeError(f"ODM_CONSOLE_DIR={root} contains no index.html")

    app.mount("/assets", StaticFiles(directory=root / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def console(path: str) -> Response:
        candidate = (root / path).resolve()
        # Only ever a file inside the console directory.
        if path and candidate.is_file() and candidate.is_relative_to(root.resolve()):
            return FileResponse(candidate)
        return FileResponse(index)


app = create_app()
