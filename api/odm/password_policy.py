"""Password policies that reach some accounts and not others.

Active Directory calls these fine-grained password policies, and Samba
implements them as password settings objects. One thing is worth being plain
about: **a password policy applies to users and groups, never to a container.**
That is true in AD and in Samba, not a limitation of ODM.

So a policy here takes groups, and optionally organizational units. The groups
are applied directly. An organizational unit is resolved to the users beneath
it and each is applied individually — which is the only way to express it —
and re-resolved whenever the policy is saved and on a periodic sweep, so
somebody created afterwards is picked up rather than quietly missed.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from typing import Any

from .dns import SAMBA_TOOL, DnsUnavailable, available

TIMEOUT_SECONDS = 60

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$")


class PasswordPolicyError(Exception):
    """The policy is not one ODM will accept, or samba-tool refused it."""


@dataclass(frozen=True)
class Definition:
    name: str
    precedence: int
    complexity: bool
    min_length: int
    history: int
    min_age_days: int
    max_age_days: int
    lockout_threshold: int
    lockout_minutes: int


def validate_name(name: str) -> str:
    name = (name or "").strip()
    if not _NAME_RE.match(name):
        raise PasswordPolicyError(f"invalid policy name {name!r}")
    return name


def _run(*args: str) -> str:
    if not available():
        raise DnsUnavailable(
            "samba-tool is not installed on the API host; password policies "
            "require the control plane to run on a domain controller"
        )
    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, validated arguments
        [SAMBA_TOOL, "domain", "passwordsettings", "pso", *args],
        capture_output=True,
        text=True,
        timeout=TIMEOUT_SECONDS,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip().splitlines()
        raise PasswordPolicyError(detail[-1] if detail else "samba-tool refused the policy")
    return completed.stdout


def settings_arguments(definition: Definition) -> list[str]:
    """The flags samba-tool takes for a policy's settings."""
    return [
        "--complexity", "on" if definition.complexity else "off",
        "--min-pwd-length", str(definition.min_length),
        "--history-length", str(definition.history),
        "--min-pwd-age", str(definition.min_age_days),
        "--max-pwd-age", str(definition.max_age_days),
        "--account-lockout-threshold", str(definition.lockout_threshold),
        "--account-lockout-duration", str(definition.lockout_minutes),
        "--reset-account-lockout-after", str(definition.lockout_minutes),
    ]


def exists(name: str) -> bool:
    try:
        _run("show", validate_name(name))
    except PasswordPolicyError:
        return False
    return True


def upsert(definition: Definition) -> None:
    """Create the policy, or bring an existing one in line with it."""
    name = validate_name(definition.name)
    arguments = settings_arguments(definition)
    if exists(name):
        _run("set", name, "--precedence", str(definition.precedence), *arguments)
    else:
        _run("create", name, str(definition.precedence), *arguments)


def delete(name: str) -> None:
    _run("delete", validate_name(name))


def applied_to(name: str) -> list[str]:
    """Who the directory currently says this policy reaches."""
    applied: list[str] = []
    inside = False
    for line in _run("show", validate_name(name)).splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("applies to"):
            inside = True
            continue
        if inside:
            if not stripped:
                break
            applied.append(stripped)
    return applied


def apply_to(name: str, principals: list[str]) -> None:
    for principal in principals:
        _run("apply", validate_name(name), principal)


def unapply_from(name: str, principals: list[str]) -> None:
    for principal in principals:
        _run("unapply", validate_name(name), principal)


def reconcile(name: str, wanted: list[str], current: list[str]) -> dict[str, list[str]]:
    """Bring what the directory holds in line with what ODM says.

    Returned rather than executed so the difference can be tested, and so an
    operator can be told what changed rather than only that something did.
    """
    wanted_set = {entry.strip() for entry in wanted if entry.strip()}
    current_set = {entry.strip() for entry in current if entry.strip()}
    return {
        "add": sorted(wanted_set - current_set),
        "remove": sorted(current_set - wanted_set),
    }


def as_json(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "precedence": row["precedence"],
        "complexity": row["complexity"],
        "min_length": row["min_length"],
        "history": row["history"],
        "min_age_days": row["min_age_days"],
        "max_age_days": row["max_age_days"],
        "lockout_threshold": row["lockout_threshold"],
        "lockout_minutes": row["lockout_minutes"],
        "group_dns": list(row["group_dns"]),
        "container_dns": list(row["container_dns"]),
        "applied_to": list(row["applied_to"]),
        "state": row["state"],
        "last_error": row["last_error"],
        "updated_at": row["updated_at"],
    }
