"""PostgreSQL pool and migration runner.

Migrations are plain numbered .sql files applied in order and recorded in
schema_migration. No ORM: the ODM metadata store is a small, explicit
schema and raw SQL keeps the audit trail obvious.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import asyncpg

from .config import get_settings

# Inside the package, so an installed copy carries its own schema. Resolved
# from the source tree it also worked one directory up, which is why an
# installed control plane silently found nothing to apply.
MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

_BOOTSTRAP = """
CREATE TABLE IF NOT EXISTS schema_migration (
    filename    text PRIMARY KEY,
    sha256      text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
);
"""


def dumps(value: Any) -> str:
    """Serialise something for a jsonb column.

    default=str because what goes into these columns comes from database rows
    and from the directory, and both carry datetimes, UUIDs and addresses that
    json refuses. Deleting a group policy object snapshotted the row it was
    about to remove and failed on its updated_at — after the object was gone
    from the console's list but before it reached the recycle bin.
    """
    return json.dumps(value, default=str)


async def create_pool() -> asyncpg.Pool:
    settings = get_settings()
    return await asyncpg.create_pool(
        settings.database_url,
        min_size=settings.db_pool_min,
        max_size=settings.db_pool_max,
    )


async def migrate(pool: asyncpg.Pool) -> list[str]:
    """Apply pending migrations; return the filenames applied."""
    # A missing directory globs to nothing, which is indistinguishable from an
    # up-to-date database. Say so instead of reporting success on an empty one.
    if not MIGRATIONS_DIR.is_dir():
        raise RuntimeError(f"no migrations directory at {MIGRATIONS_DIR}")
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
