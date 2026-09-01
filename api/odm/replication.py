"""Multi-DC replication (CLAUDE.md §4).

Samba is multi-master; an operator should be able to see replication state
and force a run without dropping to samba-tool by hand.
"""

from __future__ import annotations

import re
import subprocess
from typing import Any

from ldap3 import Connection

from . import objects
from .config import Settings
from .dns import SAMBA_TOOL, DnsError, DnsUnavailable, available
from .dns import message as samba_message

TIMEOUT_SECONDS = 120

# userAccountControl bit for a domain controller's computer account.
SERVER_TRUST_ACCOUNT = 8192

_LAST_ATTEMPT = re.compile(r"Last attempt @ (?P<when>.+?) (?P<result>was successful|failed)")
_FAILURES = re.compile(r"(?P<count>\d+) consecutive failure\(s\)")


class ReplicationError(DnsError):
    """samba-tool refused a replication command."""


def _run(*args: str) -> str:
    if not available():
        raise DnsUnavailable(
            "samba-tool is not installed on the API host; replication management "
            "requires the control plane to run on a domain controller"
        )
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, validated arguments
            [SAMBA_TOOL, "drs", *args, "-k", "yes"],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ReplicationError(f"samba-tool drs failed: {exc}") from exc
    if completed.returncode != 0:
        message = samba_message(completed.stderr, completed.stdout, "samba-tool drs failed")
        if "ACCESS_DENIED" in message:
            raise ReplicationError(
                "the control plane's account may not read replication state. "
                "Re-run deploy/create-api-service-account.sh on a domain "
                "controller to grant it."
            )
        raise ReplicationError(message)
    return completed.stdout


def controllers(conn: Connection, settings: Settings) -> list[dict[str, Any]]:
    """Every domain controller, from its computer account."""
    found = objects.search(
        conn,
        settings,
        object_type="computer",
        container=None,
        query=None,
        scope="subtree",
        limit=200,
    )[0]
    return [
        {
            "name": str(entry.get("cn") or ""),
            "dns_host_name": str(entry.get("dNSHostName") or ""),
            "distinguished_name": entry["distinguishedName"],
            "operating_system": str(entry.get("operatingSystem") or ""),
        }
        for entry in found
        if int(entry.get("userAccountControl") or 0) & SERVER_TRUST_ACCOUNT
    ]


def status(settings: Settings, server: str | None = None) -> dict[str, Any]:
    """Parse `samba-tool drs showrepl` into something a table can render."""
    target = server or settings.ldap_uri.removeprefix("ldaps://").split(":")[0]
    output = _run("showrepl", target)

    inbound: list[dict[str, Any]] = []
    section = ""
    current: dict[str, Any] | None = None

    for raw in output.splitlines():
        line = raw.strip()
        # "OUTBOUND" contains "INBOUND", so it is tested first.
        if "OUTBOUND NEIGHBORS" in line or line.startswith("KCC CONNECTION"):
            section = ""
            continue
        if "INBOUND NEIGHBORS" in line:
            section = "inbound"
            continue
        if section != "inbound" or not line:
            continue

        if line.startswith(("DC=", "CN=")):
            current = {"naming_context": line, "partner": "", "last_attempt": "",
                       "succeeded": None, "failures": 0}
            inbound.append(current)
            continue
        if current is None:
            continue
        if " via RPC" in line:
            current["partner"] = line.split(" via RPC")[0].strip()
        attempt = _LAST_ATTEMPT.search(line)
        if attempt:
            current["last_attempt"] = attempt.group("when").strip()
            current["succeeded"] = attempt.group("result") == "was successful"
        failures = _FAILURES.search(line)
        if failures:
            current["failures"] = int(failures.group("count"))

    healthy = all(entry["succeeded"] is not False for entry in inbound)
    return {"server": target, "inbound": inbound, "healthy": healthy}


def replicate(settings: Settings, destination: str, source: str, naming_context: str) -> str:
    """Force one replication run between two controllers."""
    for value in (destination, source):
        if not re.match(r"^[A-Za-z0-9._-]{1,253}$", value):
            raise ReplicationError(f"invalid server name {value!r}")
    if not re.match(r"^(DC|CN)=[A-Za-z0-9=,. _-]{1,1024}$", naming_context):
        raise ReplicationError("invalid naming context")
    return _run("replicate", destination, source, naming_context)
