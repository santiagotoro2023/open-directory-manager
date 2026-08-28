"""FastAPI application.

Phase 1 exposes authentication and health only. Directory, policy, DNS and
DHCP routers arrive in later phases (CLAUDE.md §7).
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import auth, db
from .config import get_settings
from .security import CSRF_HEADER, SecurityHeadersMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    if settings.keytab is not None:
        # Acceptor creds for SPNEGO, and initiator creds for ODM's own
        # read-only LDAP binds, both come from this keytab.
        os.environ.setdefault("KRB5_KTNAME", str(settings.keytab))
        os.environ.setdefault("KRB5_CLIENT_KTNAME", str(settings.keytab))
    app.state.pool = await db.create_pool()
    try:
        yield
    finally:
        await app.state.pool.close()


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

    @app.get("/api/v1/healthz", tags=["health"])
    async def healthz() -> dict[str, str]:
        async with app.state.pool.acquire() as conn:
            await conn.execute("SELECT 1")
        return {"status": "ok", "domain": settings.domain}

    return app


app = create_app()
