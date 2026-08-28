"""Server-side session store and login throttling.

Cookies carry a random token; the database only ever holds its SHA-256, so a
dump of admin_session cannot be replayed. Sessions have both an absolute
lifetime and an idle timeout, and can be revoked.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import asyncpg

from .config import Settings
from .directory import DirectoryUser


@dataclass(frozen=True)
class Session:
    id: str
    principal: str
    principal_dn: str
    principal_sid: str | None
    display_name: str
    csrf_token: str
    expires_at: datetime


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def should_lock(failures: int, max_failures: int) -> bool:
    return failures >= max_failures


async def recent_failures(
    conn: asyncpg.Connection, username: str, source_ip: str | None, window_minutes: int
) -> int:
    """Failures for this username, or from this IP, inside the window."""
    return await conn.fetchval(
        """
        SELECT count(*) FROM login_attempt
        WHERE succeeded = false
          AND occurred_at > now() - ($3 || ' minutes')::interval
          AND (lower(username) = lower($1) OR ($2 IS NOT NULL AND source_ip = $2::inet))
        """,
        username,
        source_ip,
        str(window_minutes),
    )


async def record_attempt(
    conn: asyncpg.Connection,
    *,
    username: str,
    source_ip: str | None,
    succeeded: bool,
    reason: str | None = None,
) -> None:
    await conn.execute(
        """
        INSERT INTO login_attempt (username, source_ip, succeeded, reason)
        VALUES ($1, $2::inet, $3, $4)
        """,
        username,
        source_ip,
        succeeded,
        reason,
    )


async def create(
    conn: asyncpg.Connection,
    settings: Settings,
    user: DirectoryUser,
    *,
    source_ip: str | None,
    user_agent: str | None,
) -> tuple[str, Session]:
    """Create a session; returns (cookie token, session)."""
    token = new_token()
    csrf = new_token()
    expires_at = datetime.now(UTC) + timedelta(minutes=settings.session_ttl_minutes)
    row = await conn.fetchrow(
        """
        INSERT INTO admin_session (token_sha256, csrf_token, principal, principal_dn,
                                   principal_sid, display_name, source_ip, user_agent, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8, $9)
        RETURNING id
        """,
        token_hash(token),
        csrf,
        user.user_principal_name,
        user.dn,
        user.sid,
        user.display_name,
        source_ip,
        (user_agent or "")[:512],
        expires_at,
    )
    session = Session(
        id=str(row["id"]),
        principal=user.user_principal_name,
        principal_dn=user.dn,
        principal_sid=user.sid,
        display_name=user.display_name,
        csrf_token=csrf,
        expires_at=expires_at,
    )
    return token, session


async def load(conn: asyncpg.Connection, settings: Settings, token: str) -> Session | None:
    """Look up a live session and refresh its idle timer."""
    row = await conn.fetchrow(
        """
        UPDATE admin_session SET last_seen_at = now()
        WHERE token_sha256 = $1
          AND revoked_at IS NULL
          AND expires_at > now()
          AND last_seen_at > now() - ($2 || ' minutes')::interval
        RETURNING id, principal, principal_dn, principal_sid, display_name,
                  csrf_token, expires_at
        """,
        token_hash(token),
        str(settings.session_idle_minutes),
    )
    if row is None:
        return None
    return Session(
        id=str(row["id"]),
        principal=row["principal"],
        principal_dn=row["principal_dn"],
        principal_sid=row["principal_sid"],
        display_name=row["display_name"],
        csrf_token=row["csrf_token"],
        expires_at=row["expires_at"],
    )


async def revoke(conn: asyncpg.Connection, token: str) -> str | None:
    """Revoke a session; returns the principal it belonged to, if any."""
    return await conn.fetchval(
        """
        UPDATE admin_session SET revoked_at = now()
        WHERE token_sha256 = $1 AND revoked_at IS NULL
        RETURNING principal
        """,
        token_hash(token),
    )
