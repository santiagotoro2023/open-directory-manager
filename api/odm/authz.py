"""Authorisation: what a signed-in principal may do, and where.

Membership of the Domain-Admins-equivalent group grants everything. Anyone
else gets in only through a delegated assignment: a role, holding a set of
permissions, granted to a principal at an OU scope. A permission applies to
an object when the assignment's scope is that object's container or one
above it (CLAUDE.md §4).
"""

from __future__ import annotations

from dataclasses import dataclass

import asyncpg

# Every permission the API checks. Roles are built from these names, and a
# role holding "*" holds all of them.
PERMISSIONS: tuple[str, ...] = (
    "directory.read",
    "user.write",
    "user.password.reset",
    "group.write",
    "group.member.write",
    "computer.write",
    "ou.write",
    "object.move",
    "object.delete",
    "gpo.read",
    "gpo.write",
    "admx.write",
    "dns.read",
    "dns.write",
    "dhcp.read",
    "dhcp.write",
    "recyclebin.read",
    "recyclebin.restore",
    "recyclebin.purge",
    "role.read",
    "role.install",
    "server.read",
    "share.read",
    "share.write",
    "replication.read",
    "backup.read",
    "backup.write",
    "audit.read",
    "rbac.write",
    "ca.read",
    "ca.issue",
    "replication.replicate",
    "health.read",
)

WILDCARD = "*"


class Denied(Exception):
    """The caller holds no assignment granting this, here."""


@dataclass(frozen=True)
class Grant:
    role_name: str
    scope_dn: str
    permissions: frozenset[str]

    def covers(self, permission: str) -> bool:
        return WILDCARD in self.permissions or permission in self.permissions

    def reaches(self, dn: str | None, base_dn: str) -> bool:
        """A scope covers itself and everything beneath it."""
        scope = self.scope_dn.lower()
        if dn is None:
            # A domain-wide operation needs an assignment at the domain head.
            return scope == base_dn.lower()
        target = dn.lower()
        return target == scope or target.endswith("," + scope)


async def grants_for(
    pool: asyncpg.Pool, principal_sid: str | None, group_sids: list[str] | tuple[str, ...]
) -> list[Grant]:
    """Every assignment that names this principal or one of its groups."""
    sids = [sid for sid in [principal_sid, *group_sids] if sid]
    if not sids:
        return []
    rows = await pool.fetch(
        """
        SELECT a.role_name, a.scope_dn,
               coalesce(array_agg(p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}')
                   AS permissions
        FROM rbac_assignment a
        LEFT JOIN rbac_role_permission p ON p.role_name = a.role_name
        WHERE a.principal_sid = ANY($1::text[])
        GROUP BY a.role_name, a.scope_dn
        """,
        sids,
    )
    return [
        Grant(
            role_name=row["role_name"],
            scope_dn=row["scope_dn"],
            permissions=frozenset(row["permissions"]),
        )
        for row in rows
    ]


def permits(
    grants: list[Grant], permission: str, dn: str | None, base_dn: str, *, domain_admin: bool
) -> bool:
    if domain_admin:
        return True
    return any(grant.covers(permission) and grant.reaches(dn, base_dn) for grant in grants)


def describe(grants: list[Grant], *, domain_admin: bool) -> dict[str, object]:
    """What the UI shows the signed-in operator about their own reach."""
    if domain_admin:
        return {"domain_admin": True, "permissions": [WILDCARD], "scopes": []}
    permissions = sorted({p for grant in grants for p in grant.permissions})
    return {
        "domain_admin": False,
        "permissions": permissions,
        "scopes": [
            {"role": grant.role_name, "scope_dn": grant.scope_dn} for grant in grants
        ],
    }
