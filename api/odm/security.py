"""Request-level security: headers, origin checks, session and CSRF gates."""

from __future__ import annotations

import secrets

import asyncpg
from fastapi import Depends, HTTPException, Request, status
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from . import sessions
from .config import Settings, get_settings
from .sessions import Session

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
CSRF_HEADER = "X-ODM-CSRF"

_RESPONSE_HEADERS = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cache-Control": "no-store",
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Adds hardening headers and rejects cross-origin state changes.

    Browsers always send Origin on cross-origin state-changing requests, so a
    mismatch is refused before any handler runs. Requests without Origin (the
    Go agent, curl) are left to the session/Kerberos gates.
    """

    async def dispatch(self, request: Request, call_next):
        if request.method not in SAFE_METHODS:
            origin = request.headers.get("origin")
            allowed = get_settings().allowed_origins
            if origin is not None and origin not in allowed:
                return JSONResponse(
                    {"detail": "origin not allowed"}, status_code=status.HTTP_403_FORBIDDEN
                )
        response: Response = await call_next(request)
        for key, value in _RESPONSE_HEADERS.items():
            response.headers.setdefault(key, value)
        return response


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def set_session_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=settings.session_ttl_minutes * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/",
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        settings.session_cookie_name,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/",
    )


def get_pool(request: Request) -> asyncpg.Pool:
    return request.app.state.pool


async def current_session(
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
    settings: Settings = Depends(get_settings),
) -> Session:
    """Require a live session, and a matching CSRF token on state changes."""
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not authenticated")
    async with pool.acquire() as conn:
        session = await sessions.load(conn, settings, token)
    if session is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session expired")
    if request.method not in SAFE_METHODS:
        supplied = request.headers.get(CSRF_HEADER, "")
        if not secrets.compare_digest(supplied, session.csrf_token):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "csrf token mismatch")
    return session
