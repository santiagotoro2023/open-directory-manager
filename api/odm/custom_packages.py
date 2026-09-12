"""Software an operator uploads directly, for machines with no apt repository
that carries it.

A policy object names a package it deployed this way by id, not by content:
the .deb itself is kept on the control plane's own disk, under
custom_package_dir, and a machine fetches it once — over the same Kerberos
channel it already fetches policy through — and keeps it only long enough to
install it. Embedding the file in the policy document itself, the way a font
or a background picture is, would mean every machine the policy reaches
re-fetching the whole thing, routinely tens of megabytes, on every poll.

dpkg-deb is what actually reads a .deb; this never parses one by hand.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

from .config import Settings

# Same ceiling as the agent binary itself (agentupdate.MAX_BYTES): big enough
# for real software, small enough that one upload cannot fill the disk.
MAX_BYTES = 200 * 1024 * 1024

PACKAGE_RE = re.compile(r"^[a-z0-9][a-z0-9+.-]{0,127}$")


class CustomPackageError(Exception):
    """The upload was not usable as a package."""


@dataclass(frozen=True)
class Uploaded:
    id: str
    name: str
    file_name: str
    package_name: str
    version: str
    architecture: str
    size_bytes: int
    sha256: str


def _dir(settings: Settings) -> Path:
    path = Path(settings.custom_package_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def path_for(settings: Settings, package_id: str) -> Path:
    return _dir(settings) / f"{package_id}.deb"


def _field(path: Path, name: str) -> str:
    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["/usr/bin/dpkg-deb", "-f", str(path), name],
        capture_output=True, text=True, timeout=30, check=False,
    )
    return completed.stdout.strip()


def inspect(path: Path) -> tuple[str, str, str]:
    """The package name, version and architecture dpkg-deb finds inside it.

    Raises CustomPackageError for anything that is not a .deb dpkg-deb can
    read at all — the one check that actually matters, since everything
    installing it later trusts this file is what it claims to be.
    """
    probe = subprocess.run(  # noqa: S603
        ["/usr/bin/dpkg-deb", "--info", str(path)],
        capture_output=True, text=True, timeout=30, check=False,
    )
    if probe.returncode != 0:
        detail = probe.stderr.strip() or probe.stdout.strip()
        raise CustomPackageError(f"not a Debian package dpkg-deb can read: {detail}")
    name = _field(path, "Package")
    if not PACKAGE_RE.match(name):
        raise CustomPackageError(f"{name!r} is not a valid package name")
    return name, _field(path, "Version"), _field(path, "Architecture")


def save(settings: Settings, content: bytes, file_name: str) -> tuple[str, str, str, str]:
    """Write the upload to disk and confirm it is a real package.

    Returns (id, package_name, version, architecture). The file is removed
    again if it turns out not to be usable — an upload that fails leaves
    nothing behind to clean up later.
    """
    if not content:
        raise CustomPackageError("the file is empty")
    if len(content) > MAX_BYTES:
        raise CustomPackageError(
            f"{len(content) / 1024 / 1024:.1f} MB; packages up to "
            f"{MAX_BYTES // 1024 // 1024} MB"
        )
    package_id = str(uuid.uuid4())
    path = path_for(settings, package_id)
    path.write_bytes(content)
    path.chmod(0o640)
    try:
        package_name, version, architecture = inspect(path)
    except CustomPackageError:
        path.unlink(missing_ok=True)
        raise
    return package_id, package_name, version, architecture


def delete(settings: Settings, package_id: str) -> None:
    path_for(settings, package_id).unlink(missing_ok=True)


def sha256_of(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()
