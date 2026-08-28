"""PostgreSQL pool and migration runner.

Migrations are plain numbered .sql files applied in order and recorded in
schema_migration. No ORM: the ODM metadata store is a small, explicit
schema and raw SQL keeps the audit trail obvious.
"""

from __future__ import annotations

import asyncio
import hashlib
import sys
from pathlib import Path

import asyncpg

from .config import get_settings

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"

_BOOTSTRAP = """
CREATE TABLE IF NOT EXISTS schema_migration (
    filename    text PRIMARY KEY,
    sha256      text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
);
"""


async def create_pool() -> asyncpg.Pool:
    settings = get_settings()
    return await asyncpg.create_pool(
        settings.database_url,
        min_size=settings.db_pool_min,
        max_size=settings.db_pool_max,
    )


async def migrate(pool: asyncpg.Pool) -> list[str]:
    """Apply pending migrations; return the filenames applied."""
    applied: list[str] = []
    async with pool.acquire() as conn:
        await conn.execute(_BOOTSTRAP)
        known = {
            r["filename"]: r["sha256"] for r in await conn.fetch("SELECT * FROM schema_migration")
        }
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            body = path.read_text(encoding="utf-8")
            digest = hashlib.sha256(body.encode()).hexdigest()
            if path.name in known:
                if known[path.name] != digest:
                    raise RuntimeError(f"{path.name} changed after being applied")
                continue
            async with conn.transaction():
                await conn.execute(body)
                await conn.execute(
                    "INSERT INTO schema_migration (filename, sha256) VALUES ($1, $2)",
                    path.name,
                    digest,
                )
            applied.append(path.name)
    return applied


async def _migrate_cli() -> None:
    pool = await create_pool()
    try:
        applied = await migrate(pool)
    finally:
        await pool.close()
    print("\n".join(applied) if applied else "no pending migrations")


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] != "migrate":
        print("usage: odm-db migrate", file=sys.stderr)
        raise SystemExit(2)
    asyncio.run(_migrate_cli())
