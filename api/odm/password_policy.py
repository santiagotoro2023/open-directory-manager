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

import json
import re
import subprocess
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi.concurrency import run_in_threadpool

from . import audit, directory, objects
from .dns import SAMBA_TOOL, DnsUnavailable, available, connection_flags, message
from .objects import ObjectError

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
    # How long the failed attempts are counted over. Kept separate because
    # the directory keeps it separate, and an operator who lengthens the
    # lockout does not necessarily mean to lengthen the window.
    reset_minutes: int = 0


def validate_name(name: str) -> str:
    name = (name or "").strip()
    if not _NAME_RE.match(name):
        raise PasswordPolicyError(f"invalid policy name {name!r}")
    return name


def _run(settings, *args: str) -> str:
    if not available():
        raise DnsUnavailable(
            "samba-tool is not installed on the API host; password policies "
            "require the control plane to run on a domain controller"
        )
    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, validated arguments
        [SAMBA_TOOL, "domain", "passwordsettings", "pso", *args, *connection_flags(settings)],
        capture_output=True,
        text=True,
        timeout=TIMEOUT_SECONDS,
        check=False,
    )
    if completed.returncode != 0:
        raise PasswordPolicyError(
            message(completed.stderr, completed.stdout, "samba-tool refused the policy")
        )
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
        "--reset-account-lockout-after",
        str(definition.reset_minutes or definition.lockout_minutes),
    ]


def exists(settings, name: str) -> bool:
    try:
        _run(settings, "show", validate_name(name))
    except PasswordPolicyError:
        return False
    return True


def upsert(settings, definition: Definition) -> None:
    """Create the policy, or bring an existing one in line with it."""
    name = validate_name(definition.name)
    arguments = settings_arguments(definition)
    if exists(settings, name):
        _run(settings, "set", name, "--precedence", str(definition.precedence), *arguments)
    else:
        _run(settings, "create", name, str(definition.precedence), *arguments)


def delete(settings, name: str) -> None:
    _run(settings, "delete", validate_name(name))


def applied_to(settings, name: str) -> list[str]:
    """Who the directory currently says this policy reaches, as distinguished
    names — which is how samba-tool prints them.

    The heading it prints is "PSO applies directly to 2 groups/users:", so
    anything looking for a line starting with "applies to" found nothing and
    every reconcile believed the policy reached nobody.
    """
    return parse_applied(_run(settings, "show", validate_name(name)))


def parse_applied(printed: str) -> list[str]:
    """Exported so the heading it looks for can be tested against the real
    output rather than against what it was assumed to be."""
    applied: list[str] = []
    inside = False
    for line in printed.splitlines():
        stripped = line.strip()
        if not inside:
            if "applies" in stripped.lower() and stripped.endswith(":"):
                inside = True
            continue
        if not stripped:
            break
        applied.append(stripped)
    return applied


def group_name(dn: str) -> str:
    """The name samba-tool wants, from the distinguished name it printed."""
    first = dn.split(",", 1)[0]
    return first.split("=", 1)[1] if "=" in first else first


def apply_to(settings, name: str, principals: list[str]) -> None:
    """Applied by name, never by distinguished name: samba-tool answers a DN
    here with "The specified user or group was not found", so a policy created
    from a group's DN was created and then reached nobody.
    """
    for principal in principals:
        _run(settings, "apply", validate_name(name), principal)


def unapply_from(settings, name: str, principals: list[str]) -> None:
    for principal in principals:
        _run(settings, "unapply", validate_name(name), principal)


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


# ----------------------------------------------------- the domain's own rules ---
# Held on the domain object and enforced by the directory on every change,
# wherever it is made. It is written from a policy object like every other
# setting, which is where an operator goes to look for it — and, since it is
# not something a machine can apply, the control plane is what writes it.

_SETTING_RE = re.compile(r"^\s*([A-Za-z ()]+?)\s*:\s*(.+?)\s*$")


def _domain(settings, *args: str) -> str:
    if not available():
        raise DnsUnavailable(
            "samba-tool is not installed on the API host; the password policy "
            "requires the control plane to run on a domain controller"
        )
    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, validated arguments
        [SAMBA_TOOL, "domain", "passwordsettings", *args, *connection_flags(settings)],
        capture_output=True,
        text=True,
        timeout=TIMEOUT_SECONDS,
        check=False,
    )
    if completed.returncode != 0:
        raise PasswordPolicyError(
            message(completed.stderr, completed.stdout, "samba-tool refused the change")
        )
    return completed.stdout


def read_domain(settings) -> dict[str, Any]:
    """The domain's password policy, as the directory holds it."""
    policy: dict[str, Any] = {}
    for line in _domain(settings, "show").splitlines():
        # samba-tool writes its notices on stdout alongside the policy, and
        # "label: value" matches them: the console showed a row reading
        # WARNING / The option -k|--kerberos is deprecated!
        if line.startswith(("WARNING", "ERROR", "Note:")):
            continue
        match = _SETTING_RE.match(line)
        if not match:
            continue
        policy[match.group(1).strip()] = match.group(2).strip()
    return policy


def set_domain(settings, definition: Definition) -> None:
    _domain(settings, "set", *settings_arguments(definition))


def definition_from(name: str, document: dict[str, Any]) -> Definition:
    """One policy object's password settings, as the directory takes them."""
    return Definition(
        name=name,
        precedence=int(document.get("precedence") or 100),
        complexity=bool(document.get("complexity", True)),
        min_length=int(document.get("minimum_length") or 12),
        history=int(document.get("history") or 0),
        min_age_days=int(document.get("minimum_age_days") or 0),
        max_age_days=int(document.get("maximum_age_days") or 0),
        lockout_threshold=int(document.get("lockout_threshold") or 0),
        lockout_minutes=int(document.get("lockout_minutes") or 0),
        reset_minutes=int(
            document.get("reset_lockout_minutes", document.get("lockout_minutes")) or 0
        ),
    )


def object_name(display_name: str, guid: str) -> str:
    """What the password settings object behind a policy object is called.

    Named after the policy object so an operator reading `samba-tool domain
    passwordsettings pso list` sees where it came from. A policy object's name
    is freer than a directory name, so anything the directory would refuse is
    replaced rather than rejected — a policy must not fail to save because of
    a bracket in its name.
    """
    cleaned = re.sub(r"[^A-Za-z0-9 ._-]", "-", (display_name or "").strip())[:63].strip()
    return cleaned if _NAME_RE.match(cleaned) else f"odm-{guid[:8]}"


# Every policy object carrying password settings, and where it is linked.
_CARRIERS = """
SELECT gpo.guid, gpo.display_name, gpo.settings->'password_policy' AS document,
       link.target_dn, link.enforced, link.link_order
FROM gpo
JOIN gpo_link link ON link.gpo_guid = gpo.guid AND link.enabled
WHERE gpo.enabled AND gpo.settings ? 'password_policy'
ORDER BY link.enforced DESC, link.link_order
"""


def choose(
    rows, base_dn: str
) -> tuple[dict[str, Any] | None, dict[str, tuple[str, dict[str, Any]]]]:
    """Which policy object sets the domain's rules, and which write one of
    their own for the groups they name.

    Rows are every enabled link of every enabled policy object carrying the
    setting, in precedence order — enforced first, then link order.
    """
    root = base_dn.lower()
    domain_wide: dict[str, Any] | None = None
    fine_grained: dict[str, tuple[str, dict[str, Any]]] = {}
    for row in rows:
        document = row["document"]
        if isinstance(document, str):
            document = json.loads(document)
        if not isinstance(document, dict):
            continue
        groups = [str(name).strip() for name in document.get("groups") or [] if str(name).strip()]
        if groups:
            # A fine-grained policy reaches the groups it names wherever the
            # object is linked: it is the membership that decides who it is
            # for, which is what the directory does with it.
            fine_grained.setdefault(str(row["guid"]), (row["display_name"], document))
        elif domain_wide is None and row["target_dn"].lower() == root:
            # Linked anywhere else there is nothing for it to reach: this is
            # the domain's own policy, and the domain is the only place it can
            # be set. The first row wins — the rows are in precedence order.
            domain_wide = document
    return domain_wide, fine_grained


async def apply_effective(pool, settings, actor: str) -> None:
    """Make the directory match the password settings the domain's policy
    objects carry.

    Called wherever a policy object or a link changes, because either can
    change the answer. Nothing here raises: an operator saving an unrelated
    policy must not be stopped by a directory that will not take a password
    rule, and what went wrong is recorded where every other change to the
    domain is.
    """
    rows = await pool.fetch(_CARRIERS)
    managed = await pool.fetch(
        "SELECT name, source_gpo FROM password_policy WHERE source_gpo IS NOT NULL"
    )
    if not rows and not managed:
        return

    domain_wide, fine_grained = choose(rows, settings.base_dn)

    async def record(action: str, outcome: str, dn: str, before: Any, after: Any) -> None:
        async with pool.acquire() as conn:
            await audit.record(
                conn,
                actor=actor,
                actor_sid=None,
                source_ip=None,
                action=action,
                outcome=outcome,
                object_type="domain",
                object_dn=dn,
                before=before,
                after=after,
            )

    if domain_wide is not None:
        try:
            before = await run_in_threadpool(read_domain, settings)
            await run_in_threadpool(
                set_domain, settings, definition_from("domain", domain_wide)
            )
            after = await run_in_threadpool(read_domain, settings)
            if before != after:
                await record("password.policy.update", "success", "password-policy", before, after)
        except (PasswordPolicyError, DnsUnavailable, subprocess.SubprocessError) as exc:
            await record(
                "password.policy.update", "failure", "password-policy", None, {"error": str(exc)}
            )

    # Fine-grained policies: one password settings object per policy object,
    # applied to the groups it names.
    for guid, (display_name, document) in fine_grained.items():
        name = object_name(display_name, guid)
        wanted_names = [str(group).strip() for group in document.get("groups") or []]
        try:
            # Compared as distinguished names, because that is what the
            # directory prints; applied by name, because that is what it takes.
            targets = await _group_dns(settings, wanted_names)
            definition = definition_from(name, document)
            await run_in_threadpool(upsert, settings, definition)
            current = await run_in_threadpool(applied_to, settings, name)
            change = reconcile(name, list(targets), current)
            if change["add"]:
                await run_in_threadpool(
                    apply_to, settings, name, [targets[dn] for dn in change["add"]]
                )
            if change["remove"]:
                await run_in_threadpool(
                    unapply_from, settings, name, [group_name(dn) for dn in change["remove"]]
                )
            await pool.execute(
                """
                INSERT INTO password_policy (name, description, precedence, complexity,
                    min_length, history, min_age_days, max_age_days, lockout_threshold,
                    lockout_minutes, group_dns, applied_to, state, source_gpo, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, 'active', $12, now())
                ON CONFLICT (name) DO UPDATE SET
                    description = excluded.description, precedence = excluded.precedence,
                    complexity = excluded.complexity, min_length = excluded.min_length,
                    history = excluded.history, min_age_days = excluded.min_age_days,
                    max_age_days = excluded.max_age_days,
                    lockout_threshold = excluded.lockout_threshold,
                    lockout_minutes = excluded.lockout_minutes,
                    group_dns = excluded.group_dns, applied_to = excluded.applied_to,
                    state = 'active', last_error = NULL, source_gpo = excluded.source_gpo,
                    updated_at = now()
                """,
                name,
                f"From the policy object {display_name}",
                definition.precedence,
                definition.complexity,
                definition.min_length,
                definition.history,
                definition.min_age_days,
                definition.max_age_days,
                definition.lockout_threshold,
                definition.lockout_minutes,
                list(targets),
                uuid.UUID(guid),
            )
        except (PasswordPolicyError, DnsUnavailable, subprocess.SubprocessError,
                ObjectError) as exc:
            await pool.execute(
                """
                INSERT INTO password_policy (name, state, last_error, source_gpo, updated_at)
                VALUES ($1, 'failed', $2, $3, now())
                ON CONFLICT (name) DO UPDATE SET
                    state = 'failed', last_error = excluded.last_error, updated_at = now()
                """,
                name,
                str(exc)[:500],
                uuid.UUID(guid),
            )
            await record("password.policy.update", "failure", name, None, {"error": str(exc)})

    # A policy object that no longer carries password settings, or is gone,
    # takes its password settings object with it. Only ones ODM created from a
    # policy object: anything an operator made in the directory is theirs.
    for row in managed:
        if str(row["source_gpo"]) in fine_grained and row["name"] == object_name(
            fine_grained[str(row["source_gpo"])][0], str(row["source_gpo"])
        ):
            continue
        try:
            await run_in_threadpool(delete, settings, row["name"])
        except (PasswordPolicyError, DnsUnavailable, subprocess.SubprocessError):
            pass
        await pool.execute("DELETE FROM password_policy WHERE name = $1", row["name"])
        await record("password.policy.delete", "success", row["name"], {"name": row["name"]}, None)


async def _group_dns(settings, names: list[str]) -> dict[str, str]:
    """The groups a fine-grained policy names: distinguished name to name."""
    wanted = [name.strip() for name in names if name.strip()]
    if not wanted:
        return {}
    conn = await run_in_threadpool(directory.service_connection, settings, read_only=True)
    try:
        found: dict[str, str] = {}
        for name in wanted:
            escaped = objects.escape_filter_chars(name)
            matches = await run_in_threadpool(
                objects.search_filter,
                conn,
                settings,
                f"(&(objectClass=group)(|(sAMAccountName={escaped})(cn={escaped})))",
            )
            if not matches:
                raise ObjectError(f"no group called {name}")
            for dn in matches:
                found[dn] = name
    finally:
        await run_in_threadpool(conn.unbind)
    return found
