"""The domain measured against a security checklist.

Every check reads something ODM already knows — the directory, its own store,
what agents have reported — and answers one question an auditor asks. Nothing
here changes anything, and nothing here is a judgement about how a domain
should be run: each check says what it found, what good looks like, and where
to go and change it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

# What a check can say. Ordered worst first, which is the order a report
# should read in.
SEVERITIES = ("critical", "warning", "advisory", "ok", "unknown")


@dataclass
class Check:
    key: str
    title: str
    severity: str
    finding: str
    # Where in the console this is fixed. A finding nobody can act on is a
    # complaint rather than a report.
    where: str = ""
    # How many objects it is about, where that is the point of the check.
    count: int = 0
    detail: list[str] = field(default_factory=list)

    def as_json(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "title": self.title,
            "severity": self.severity,
            "finding": self.finding,
            "where": self.where,
            "count": self.count,
            "detail": self.detail[:25],
        }


def score(checks: list[Check]) -> dict[str, int]:
    """How many checks landed on each answer."""
    counts = {severity: 0 for severity in SEVERITIES}
    for check in checks:
        counts[check.severity] = counts.get(check.severity, 0) + 1
    return counts


# ------------------------------------------------------------ the checks ---
#
# Each takes the facts it needs and returns one Check. Pure, so every one of
# them is testable without a domain.


def stale_accounts(users: list[dict[str, Any]], days: int, now: datetime) -> Check:
    """Enabled accounts nobody has signed in with for a long time.

    The most common way an estate is broken into is an account that still
    works and that nobody would notice being used.
    """
    cutoff = now - timedelta(days=days)
    stale = []
    for user in users:
        if user.get("disabled"):
            continue
        last = user.get("last_logon")
        if last is None or last < cutoff:
            stale.append(user.get("name") or "")
    if not stale:
        return Check(
            "stale-accounts",
            "Dormant accounts",
            "ok",
            f"No enabled account has been unused for {days} days.",
            "Directory",
        )
    return Check(
        "stale-accounts",
        "Dormant accounts",
        "warning" if len(stale) < 10 else "critical",
        f"{len(stale)} enabled account(s) have not signed in for {days} days.",
        "Directory",
        len(stale),
        sorted(stale),
    )


def passwords_never_expire(users: list[dict[str, Any]]) -> Check:
    found = sorted(
        user.get("name") or "" for user in users
        if user.get("password_never_expires") and not user.get("disabled")
    )
    if not found:
        return Check(
            "password-never-expires",
            "Passwords that never expire",
            "ok",
            "Every enabled account is subject to the password policy.",
            "Passwords",
        )
    return Check(
        "password-never-expires",
        "Passwords that never expire",
        "warning",
        f"{len(found)} enabled account(s) are exempt from password expiry.",
        "Passwords",
        len(found),
        found,
    )


def privileged_accounts(members: list[str], limit: int = 5) -> Check:
    """How many people can do anything at all.

    Not a number ODM can be right about for every estate, so it is an
    advisory: what it is for is making the number visible at all.
    """
    if not members:
        return Check(
            "privileged-accounts",
            "Domain administrators",
            "critical",
            "Nobody is a domain administrator, so nobody can administer the domain.",
            "Directory",
        )
    severity = "ok" if len(members) <= limit else "advisory"
    return Check(
        "privileged-accounts",
        "Domain administrators",
        severity,
        f"{len(members)} account(s) can administer the whole domain.",
        "Directory",
        len(members),
        sorted(members),
    )


def second_factor(admins: list[str], enrolled: set[str]) -> Check:
    missing = sorted(name for name in admins if name.lower() not in enrolled)
    if not admins:
        return Check("second-factor", "Second factor on administrators", "unknown",
                     "No administrators to check.", "Directory")
    if not missing:
        return Check(
            "second-factor",
            "Second factor on administrators",
            "ok",
            "Every domain administrator has a second factor.",
            "Directory",
        )
    return Check(
        "second-factor",
        "Second factor on administrators",
        "critical",
        f"{len(missing)} domain administrator(s) sign in with a password alone.",
        "Directory",
        len(missing),
        missing,
    )


def agents_reporting(total: int, stale: int, hours: int) -> Check:
    if total == 0:
        return Check("agents", "Machines reporting", "unknown",
                     "No machine has ever reported.", "Servers")
    if stale == 0:
        return Check("agents", "Machines reporting", "ok",
                     f"All {total} machines have reported in the last {hours} hours.",
                     "Servers")
    return Check(
        "agents",
        "Machines reporting",
        "warning" if stale * 4 < total else "critical",
        f"{stale} of {total} machines have not reported for {hours} hours, so policy is "
        "not reaching them.",
        "Servers",
        stale,
    )


def backups(last: datetime | None, now: datetime, days: int = 7) -> Check:
    if last is None:
        return Check("backups", "Domain backups", "critical",
                     "No backup of this domain has ever completed.", "Overview")
    age = (now - last).days
    if age <= days:
        return Check("backups", "Domain backups", "ok",
                     f"The last backup completed {age} day(s) ago.", "Overview")
    return Check("backups", "Domain backups", "critical",
                 f"The last backup completed {age} days ago.", "Overview")


def certificate_expiry(expiring: list[dict[str, Any]], days: int = 30) -> Check:
    if not expiring:
        return Check("certificates", "Certificates expiring", "ok",
                     f"No certificate expires in the next {days} days.", "Certificates")
    return Check(
        "certificates",
        "Certificates expiring",
        "warning",
        f"{len(expiring)} certificate(s) expire in the next {days} days.",
        "Certificates",
        len(expiring),
        sorted(str(row.get("subject") or "") for row in expiring),
    )


def encryption(machines: list[dict[str, Any]]) -> Check:
    """Machines with no encrypted volume at all."""
    if not machines:
        return Check("encryption", "Disk encryption", "unknown",
                     "No machine has reported its disks.", "Servers")
    unencrypted = sorted(
        str(machine.get("hostname") or "")
        for machine in machines
        if not any(volume.get("encrypted") for volume in machine.get("volumes") or [])
    )
    if not unencrypted:
        return Check("encryption", "Disk encryption", "ok",
                     "Every machine reports at least one encrypted volume.", "Servers")
    return Check(
        "encryption",
        "Disk encryption",
        "warning",
        f"{len(unencrypted)} machine(s) report no encrypted volume.",
        "Servers",
        len(unencrypted),
        unencrypted,
    )


def password_policy(policy: dict[str, Any] | None) -> Check:
    """The domain's own password rules, against what is generally asked for."""
    if not policy:
        return Check("password-policy", "Password policy", "unknown",
                     "The domain's password policy could not be read.", "Passwords")
    problems = []
    if int(policy.get("min_length") or 0) < 12:
        problems.append(f"minimum length is {policy.get('min_length')}")
    if not policy.get("complexity"):
        problems.append("complexity is off")
    if int(policy.get("lockout_threshold") or 0) == 0:
        problems.append("no lockout after repeated failures")
    if not problems:
        return Check("password-policy", "Password policy", "ok",
                     "The domain's password policy meets the usual baseline.", "Passwords")
    return Check(
        "password-policy",
        "Password policy",
        "warning",
        "; ".join(problems).capitalize() + ".",
        "Passwords",
        len(problems),
        problems,
    )


def delegation(assignments: list[dict[str, Any]]) -> Check:
    """Delegated administration granted over the whole domain rather than
    over a part of it."""
    domain_wide = sorted(
        f"{row.get('principal')} as {row.get('role_name')}"
        for row in assignments
        if not row.get("scope_dn") or str(row.get("scope_dn", "")).count(",") <= 1
    )
    if not domain_wide:
        return Check("delegation", "Delegated administration", "ok",
                     "Every delegation is scoped to part of the directory.", "Delegation")
    return Check(
        "delegation",
        "Delegated administration",
        "advisory",
        f"{len(domain_wide)} delegation(s) apply to the whole domain.",
        "Delegation",
        len(domain_wide),
        domain_wide,
    )


def now_utc() -> datetime:
    return datetime.now(UTC)
