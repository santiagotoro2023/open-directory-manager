"""Machine enrolment (CLAUDE.md §5.6).

A one-time token lets a machine join without a domain administrator
credential reaching the client. Redeeming it creates the host account and
returns that machine's own keytab; nothing else is handed over.
"""

from __future__ import annotations

import re
import secrets
import string
import subprocess
import tempfile
from pathlib import Path

from .config import Settings
from .dns import SAMBA_TOOL, DnsError, DnsUnavailable, available

TIMEOUT_SECONDS = 120
HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?"
                         r"(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$")
PASSWORD_ALPHABET = string.ascii_letters + string.digits + "@#%^*_-+="


class EnrolmentError(DnsError):
    """The machine could not be enrolled."""


def new_token() -> str:
    return secrets.token_urlsafe(32)


def machine_password() -> str:
    """A long random password for a machine account, which never types it."""
    return "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(48))


def validate_hostname(hostname: str) -> str:
    hostname = hostname.strip().lower().rstrip(".")
    if not HOSTNAME_RE.match(hostname):
        raise EnrolmentError(f"invalid host name {hostname!r}")
    return hostname


def short_name(hostname: str) -> str:
    return validate_hostname(hostname).split(".", 1)[0]


def _run(*args: str) -> str:
    if not available():
        raise DnsUnavailable(
            "samba-tool is not installed on the API host; token enrolment requires "
            "the control plane to run on a domain controller"
        )
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, validated arguments
            [SAMBA_TOOL, *args],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EnrolmentError(f"samba-tool failed: {exc}") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip().splitlines()
        raise EnrolmentError(detail[-1] if detail else "samba-tool failed")
    return completed.stdout


def provision_machine(settings: Settings, hostname: str, container_dn: str) -> bytes:
    """Create or reset the host account and return its keytab.

    The account password is generated here, used once to set the account, and
    never leaves this function; what the client receives is the keytab
    derived from it.
    """
    fqdn = validate_hostname(hostname)
    short = short_name(fqdn)
    password = machine_password()

    existing = _run(
        "computer", "list", "-k", "yes"
    ).splitlines()
    if short in {line.strip().rstrip("$") for line in existing}:
        # Re-enrolling a machine resets its account rather than failing.
        _run("user", "setpassword", f"{short}$", f"--newpassword={password}", "-k", "yes")
    else:
        _run(
            "computer",
            "create",
            short,
            f"--computerou={container_dn}",
            "-k",
            "yes",
        )
        _run("user", "setpassword", f"{short}$", f"--newpassword={password}", "-k", "yes")

    with tempfile.TemporaryDirectory() as workspace:
        keytab = Path(workspace) / "machine.keytab"
        _run(
            "domain",
            "exportkeytab",
            str(keytab),
            f"--principal={short}$@{settings.realm}",
            "-k",
            "yes",
        )
        if not keytab.exists():
            raise EnrolmentError("samba-tool produced no keytab")
        return keytab.read_bytes()
