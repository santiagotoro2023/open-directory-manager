"""The agent binary this domain hands out, and what version it is.

A machine's agent is updated today by somebody signing in to that machine,
which does not scale past a handful and is the one job that most wants doing
remotely: the agent is what makes every other remote job possible, so the
version it is on decides which of them work.

The binary served is the one this console was deployed with — the same file
the setup script installs and rebuilds. Nothing is fetched from the internet:
a machine that can reach the console can be updated, and a machine that
cannot is not one an update should be reaching anyway. The transfer rides the
channel the agent already has, which is TLS to a console it has verified,
authenticated by the machine's own Kerberos identity.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

# "odm-agent 0.7.12" — what the binary prints when asked.
_VERSION_RE = re.compile(r"\b(\d+\.\d+\.\d+)\b")

# Refuse to serve anything absurd as an agent: this file becomes /usr/sbin on
# every machine in the domain.
MAX_BYTES = 200 * 1024 * 1024


@dataclass(frozen=True)
class Available:
    """The agent this console will hand out."""

    version: str
    path: Path
    size: int
    sha256: str


# Keyed by the file's identity rather than its name: hashing a 30 MB binary on
# every check-in in a domain of any size is real work, and the answer only
# changes when the file does.
_cache: dict[tuple[str, int, int], Available] = {}


def available(binary: Path | None) -> Available | None:
    """What version is on offer, or None where there is no binary to offer.

    None is not an error. A console installed without the agent beside it
    simply has nothing to hand out, and every machine keeps what it has.
    """
    if binary is None:
        return None
    try:
        stat = binary.stat()
    except OSError:
        return None
    if not stat.st_size or stat.st_size > MAX_BYTES:
        return None

    key = (str(binary), stat.st_size, int(stat.st_mtime))
    if key in _cache:
        return _cache[key]

    version = _version_of(binary)
    if not version:
        return None
    digest = hashlib.sha256()
    with binary.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)

    found = Available(
        version=version, path=binary, size=stat.st_size, sha256=digest.hexdigest()
    )
    # One entry: the only file that matters is the current one.
    _cache.clear()
    _cache[key] = found
    return found


def _version_of(binary: Path) -> str:
    """Ask the binary. Its own answer is the only one that cannot drift from
    what a machine will actually be running once it has this file."""
    try:
        result = subprocess.run(  # noqa: S603 - fixed path from configuration, fixed argument
            [str(binary), "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if result.returncode != 0:
        return ""
    found = _VERSION_RE.search(result.stdout)
    return found.group(1) if found else ""


def newer(available_version: str, installed: str) -> bool:
    """Whether the offer is worth taking.

    Compared as numbers rather than as text, because "0.7.9" sorts after
    "0.7.12" as text and a domain would have stopped updating at the tenth
    patch release.
    """
    if not available_version:
        return False
    if not installed:
        return True
    return _parts(available_version) > _parts(installed)


def _parts(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", version)[:3])
