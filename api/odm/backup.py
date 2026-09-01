"""Domain backup (CLAUDE.md §4).

Wraps `samba-tool domain backup online`, which produces one archive holding
the directory, SYSVOL and the domain's own configuration.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

from .config import Settings
from .dns import SAMBA_TOOL, DnsError, DnsUnavailable, available, message

TIMEOUT_SECONDS = 3600
ARCHIVE_RE = re.compile(r"^samba-backup-.*\.tar\.bz2$")


class BackupError(DnsError):
    """The backup could not be taken."""


def directory(settings: Settings) -> Path:
    if settings.backup_dir is None:
        raise BackupError("no backup directory configured (ODM_BACKUP_DIR is unset)")
    return Path(settings.backup_dir)


def configured(settings: Settings) -> bool:
    return settings.backup_dir is not None


def take(settings: Settings, server: str | None = None) -> dict[str, Any]:
    """Run an online backup. Blocking, and slow — run it in the background."""
    if not available():
        raise DnsUnavailable(
            "samba-tool is not installed on the API host; backups require the "
            "control plane to run on a domain controller"
        )
    target_dir = directory(settings)
    target_dir.mkdir(parents=True, exist_ok=True)
    before = set(target_dir.glob("samba-backup-*.tar.bz2"))

    server_name = server or settings.ldap_uri.removeprefix("ldaps://").split(":")[0]
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, validated arguments
            [
                SAMBA_TOOL,
                "domain",
                "backup",
                "online",
                f"--server={server_name}",
                f"--targetdir={target_dir}",
                "-k",
                "yes",
            ],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BackupError(f"backup did not complete: {exc}") from exc
    if completed.returncode != 0:
        raise BackupError(
            message(completed.stderr, completed.stdout, "samba-tool domain backup failed")
        )

    created = sorted(set(target_dir.glob("samba-backup-*.tar.bz2")) - before)
    if not created:
        raise BackupError("samba-tool reported success but produced no archive")
    archive = created[-1]
    return {"path": str(archive), "size_bytes": archive.stat().st_size}


def archives(settings: Settings) -> list[dict[str, Any]]:
    """Backup archives present on disk, newest first."""
    if not configured(settings):
        return []
    target_dir = directory(settings)
    if not target_dir.exists():
        return []
    found = [
        {
            "path": str(path),
            "size_bytes": path.stat().st_size,
            "modified_at": path.stat().st_mtime,
        }
        for path in target_dir.iterdir()
        if path.is_file() and ARCHIVE_RE.match(path.name)
    ]
    return sorted(found, key=lambda entry: entry["modified_at"], reverse=True)


def prune(settings: Settings, keep: int) -> list[str]:
    """Remove archives beyond the retention count, newest kept."""
    removed = []
    for entry in archives(settings)[max(keep, 1) :]:
        path = Path(entry["path"])
        # Only ever inside the configured directory, and only archives.
        if path.parent == directory(settings) and ARCHIVE_RE.match(path.name):
            path.unlink(missing_ok=True)
            removed.append(str(path))
    return removed
