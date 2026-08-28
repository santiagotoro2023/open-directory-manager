"""The shape of the API surface itself.

These are regression guards rather than behaviour tests: they fail when a
new endpoint is added without an authorisation gate, or when the set of
deliberately public endpoints changes.
"""

from __future__ import annotations

import conftest  # noqa: F401  (environment setup ordering)
from fastapi.routing import APIRoute

from odm import authz
from odm.main import create_app

# Endpoints that answer before anyone is authenticated. Each is public for a
# stated reason; adding to this set is a deliberate decision.
PUBLIC = {
    ("POST", "/api/v1/auth/login"),      # authenticates a credential
    ("POST", "/api/v1/auth/negotiate"),  # authenticates a Kerberos ticket
    ("POST", "/api/v1/join/redeem"),     # authenticated by the enrolment token
    ("GET", "/api/v1/healthz"),          # liveness probe
}


def routes() -> list[APIRoute]:
    """Every endpoint, flattened.

    Included routers are kept as wrappers rather than flattened into the
    parent, so this walks into anything that carries routes of its own.
    """
    found: list[APIRoute] = []
    pending = list(create_app().routes)
    while pending:
        route = pending.pop()
        if isinstance(route, APIRoute):
            found.append(route)
            continue
        included = getattr(route, "original_router", None)
        if included is not None:
            pending.extend(included.routes)
        elif hasattr(route, "routes"):
            pending.extend(route.routes)
    return found


def dependency_names(route: APIRoute) -> set[str]:
    names: set[str] = set()
    pending = [route.dependant]
    while pending:
        current = pending.pop()
        if current.call is not None:
            names.add(getattr(current.call, "__name__", ""))
        pending.extend(current.dependencies)
    return names


GATES = {"require_admin", "current_session", "require_machine", "dependency", "authorization"}


def test_every_endpoint_is_gated_unless_it_is_deliberately_public():
    ungated = set()
    for route in routes():
        for method in route.methods - {"HEAD", "OPTIONS"}:
            if (method, route.path) in PUBLIC:
                continue
            if not dependency_names(route) & GATES:
                ungated.add((method, route.path))
    assert ungated == set(), f"endpoints with no authorisation gate: {sorted(ungated)}"


def test_the_public_surface_has_not_grown():
    """Everything answering without a session is one of the known four."""
    public = set()
    for route in routes():
        if dependency_names(route) & GATES:
            continue
        for method in route.methods - {"HEAD", "OPTIONS"}:
            public.add((method, route.path))
    assert public == PUBLIC


def test_agent_endpoints_use_kerberos_not_a_session():
    for route in routes():
        if route.path.startswith("/api/v1/agent/"):
            names = dependency_names(route)
            assert "require_machine" in names, route.path
            assert "require_admin" not in names, route.path


def test_delegation_management_is_reserved_for_domain_administrators():
    for route in routes():
        if route.path.startswith("/api/v1/rbac/"):
            assert "dependency" in dependency_names(route), route.path


def test_every_permission_a_route_declares_is_a_known_permission():
    """A typo in a permission name would silently deny everyone."""
    import pathlib
    import re

    declared = set()
    for path in pathlib.Path("odm").glob("routes_*.py"):
        declared.update(re.findall(r'requires\("([^"]+)"\)', path.read_text()))
        declared.update(re.findall(r'authz\.require\(\s*"([^"]+)"', path.read_text()))
    unknown = declared - set(authz.PERMISSIONS) - {"*"}
    assert unknown == set(), f"routes reference unknown permissions: {sorted(unknown)}"


def test_every_permission_is_held_by_at_least_one_built_in_role():
    """A permission no role can hold could never be delegated."""
    import pathlib
    import re

    seeded = set()
    for migration in sorted(pathlib.Path("migrations").glob("*.sql")):
        seeded.update(re.findall(r"'[a-z-]+', '([a-z.*]+)'\)", migration.read_text()))
    # Domain-administrator-only actions are deliberately not in any role.
    reserved = {"rbac.write", "role.install"}
    missing = set(authz.PERMISSIONS) - seeded - reserved
    assert missing == set(), f"permissions no built-in role holds: {sorted(missing)}"
