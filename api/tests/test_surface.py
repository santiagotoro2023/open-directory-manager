"""The shape of the API surface itself.

These are regression guards rather than behaviour tests: they fail when a
new endpoint is added without an authorisation gate, or when the set of
deliberately public endpoints changes.
"""

from __future__ import annotations

import conftest  # noqa: F401  (environment setup ordering)
import pytest
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
    for migration in sorted(pathlib.Path("odm/migrations").glob("*.sql")):
        # Underscores are legal in a permission name; the class has to allow
        # them or a real grant reads as a missing one.
        seeded.update(re.findall(r"'[a-z-]+', '([a-z._*]+)'\)", migration.read_text()))
    # Domain-administrator-only actions are deliberately not in any role.
    reserved = {"rbac.write", "role.install"}
    missing = set(authz.PERMISSIONS) - seeded - reserved
    assert missing == set(), f"permissions no built-in role holds: {sorted(missing)}"


def test_every_setting_is_in_the_example_secrets_file():
    """A setting nobody can discover is a setting nobody configures."""
    import pathlib
    import re

    from odm.config import Settings

    example = (pathlib.Path("..") / "deploy" / "odm.env.example").read_text()
    documented = set(re.findall(r"^#?(ODM_[A-Z_]+)=", example, re.M))
    defined = {"ODM_" + name.upper() for name in Settings.model_fields}

    assert defined - documented == set(), (
        f"settings missing from odm.env.example: {sorted(defined - documented)}"
    )
    assert documented - defined == set(), (
        f"odm.env.example names settings that do not exist: {sorted(documented - defined)}"
    )


def test_every_migration_is_numbered_in_sequence():
    """Migrations are applied in filename order; a gap or a duplicate breaks it."""
    import pathlib

    numbers = sorted(
        int(path.name.split("_", 1)[0])
        for path in pathlib.Path("odm/migrations").glob("*.sql")
    )
    assert numbers == list(range(1, len(numbers) + 1)), numbers


# ------------------------------------------------------------- the console ---


def build_console(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "index.html").write_text("<!doctype html><title>ODM</title>")
    return tmp_path


def console_app(tmp_path):
    from fastapi import FastAPI

    from odm.config import Settings
    from odm.main import _serve_console

    app = FastAPI()

    @app.get("/api/v1/marker")
    async def marker() -> dict[str, bool]:
        return {"api": True}

    _serve_console(
        app,
        Settings(
            realm="corp.example.internal",
            domain="corp.example.internal",
            ldap_uri="ldaps://dc1",
            ldap_ca_cert="/nonexistent",
            database_url="postgresql://odm@localhost/odm",
            console_dir=build_console(tmp_path),
        ),
    )
    return app


async def test_serving_the_console_does_not_shadow_the_api(tmp_path):
    import httpx

    app = console_app(tmp_path)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://odm.test"
    ) as client:
        # The API is mounted first, so the catch-all never sees its paths.
        assert (await client.get("/api/v1/marker")).json() == {"api": True}
        # A real asset is served as itself.
        assert "console.log" in (await client.get("/assets/app.js")).text
        # Anything else is the application shell, because the console routes
        # on the client side.
        for path in ("/", "/directory", "/wiki/dhcp"):
            response = await client.get(path)
            assert response.status_code == 200
            assert "<title>ODM</title>" in response.text


async def test_the_console_never_serves_a_file_outside_its_directory(tmp_path):
    import httpx

    app = console_app(tmp_path)
    (tmp_path.parent / "secret.txt").write_text("not for the web")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://odm.test"
    ) as client:
        response = await client.get("/../secret.txt")
        assert "not for the web" not in response.text


def test_a_console_directory_without_an_index_is_refused(tmp_path):
    import pytest
    from fastapi import FastAPI

    from odm.config import Settings
    from odm.main import _serve_console

    with pytest.raises(RuntimeError):
        _serve_console(
            FastAPI(),
            Settings(
                realm="corp.example.internal",
                domain="corp.example.internal",
                ldap_uri="ldaps://dc1",
                ldap_ca_cert="/nonexistent",
                database_url="postgresql://odm@localhost/odm",
                console_dir=tmp_path,
            ),
        )


def test_the_unit_gives_the_service_a_home_it_can_read():
    """ProtectHome makes /home unreadable, and a denied stat is not a missing
    file. asyncpg checks ~/.postgresql for a client certificate on every
    connection, so a HOME under /home fails startup outright."""
    import pathlib

    unit = (pathlib.Path("..") / "deploy" / "odm-api.service").read_text()

    assert "ProtectHome=true" in unit, "this test guards ProtectHome; it is gone"

    home = [
        line.split("=", 2)[2].strip()
        for line in unit.splitlines()
        if line.startswith("Environment=HOME=")
    ]
    assert home, "the unit sets ProtectHome but never sets HOME"
    assert not home[0].startswith("/home"), (
        f"HOME is {home[0]}, which ProtectHome makes unreadable"
    )

    writable = next(
        line.split("=", 1)[1].split()
        for line in unit.splitlines()
        if line.startswith("ReadWritePaths=")
    )
    assert any(home[0] == path or home[0].startswith(path + "/") for path in writable), (
        f"HOME is {home[0]}, which is outside ReadWritePaths {writable}"
    )


async def test_json_responses_forbid_every_source(client):
    """The API answers with JSON and needs no sources at all."""
    response = await client.get("/api/v1/healthz")
    csp = response.headers["content-security-policy"]
    assert csp.startswith("default-src 'none'")
    assert "script-src" not in csp


def test_documents_may_load_the_console_they_are_served_with():
    """A document served by this app is the console shell, and a CSP of
    default-src 'none' stops the browser fetching its script at all: a blank
    page, with no request in the access log to explain it."""
    from odm.security import _CONSOLE_CSP

    directives = dict(
        part.strip().split(" ", 1) for part in _CONSOLE_CSP.split(";") if part.strip()
    )

    # What the built index.html actually references.
    assert directives["script-src"] == "'self'"
    assert directives["style-src"] == "'self'"
    assert "'self'" in directives["img-src"]
    # The console talks to its own API.
    assert directives["connect-src"] == "'self'"
    # Same-origin only, and no inline execution anywhere.
    assert directives["default-src"] == "'none'"
    assert "unsafe-inline" not in _CONSOLE_CSP
    assert "unsafe-eval" not in _CONSOLE_CSP
    assert directives["frame-ancestors"] == "'none'"
    assert directives["base-uri"] == "'none'"


def test_the_built_console_has_no_inline_script_for_the_policy_to_block():
    """script-src 'self' is only sufficient while the build stays free of
    inline script. If a build starts inlining one, this fails rather than the
    console silently going blank."""
    import pathlib
    import re

    index = pathlib.Path("..") / "web" / "dist" / "index.html"
    if not index.is_file():
        pytest.skip("console not built here")
    html = index.read_text()
    assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>\s*\S", html), (
        "the built console inlines a script, which script-src 'self' blocks"
    )


async def test_an_html_response_really_gets_the_console_policy():
    """The constant is only useful if the middleware applies it to documents.
    Exercised through the middleware rather than by reading its source."""
    import httpx
    from fastapi import FastAPI
    from fastapi.responses import HTMLResponse

    from odm.security import SecurityHeadersMiddleware

    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware)

    @app.get("/shell")
    async def shell():
        return HTMLResponse("<!doctype html><html></html>")

    @app.get("/data")
    async def data():
        return {"ok": True}

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://odm.invalid") as http:
        document = await http.get("/shell")
        payload = await http.get("/data")

    assert "script-src 'self'" in document.headers["content-security-policy"]
    assert "script-src" not in payload.headers["content-security-policy"]


def test_the_package_carries_its_own_migrations():
    """An installed control plane must find its schema inside itself.

    Resolved one directory up it worked from a source tree and found nothing
    once installed, so setup reported a migrated database that was empty."""
    import pathlib

    import odm
    from odm.db import MIGRATIONS_DIR

    package = pathlib.Path(odm.__file__).resolve().parent
    assert MIGRATIONS_DIR.is_relative_to(package), (
        f"{MIGRATIONS_DIR} is outside the package, so an install leaves it behind"
    )
    assert sorted(MIGRATIONS_DIR.glob("*.sql")), "no migrations found"

    # Being inside the package is not enough; the build has to be told to ship
    # non-Python files.
    pyproject = (pathlib.Path("pyproject.toml")).read_text()
    assert 'odm = ["migrations/*.sql"]' in pyproject, (
        "pyproject does not declare the migrations as package data"
    )


async def test_migrating_without_a_schema_is_an_error_not_a_success(monkeypatch):
    """Silence was the actual defect: a missing directory globs to nothing,
    which looks exactly like an up-to-date database."""
    import pathlib

    from odm import db

    monkeypatch.setattr(db, "MIGRATIONS_DIR", pathlib.Path("/nonexistent/migrations"))
    with pytest.raises(RuntimeError, match="no migrations directory"):
        await db.migrate(pool=None)


def test_the_directory_is_configured_to_accept_the_control_planes_bind() -> None:
    # ldap3's GSSAPI brings no SASL security layer, which Samba refuses by
    # default. Without this the service bind fails and every page past sign-in
    # answers 503, so both the guided installer and the standalone provision
    # script have to set it.
    import pathlib

    for script in ("provision-dc.sh", "setup.sh"):
        body = (pathlib.Path("..") / "deploy" / script).read_text()
        assert "ldap server require strong auth = allow_sasl_over_tls" in body, script


def test_a_typed_password_survives_the_installers_prompt() -> None:
    """The prompt is read through a command substitution, so anything the
    function writes to stdout becomes part of the secret. A stray newline here
    provisioned the domain with a password nobody could type, and every sign-in
    answered "invalid credentials" truthfully."""
    import pathlib
    import re
    import subprocess

    body = (pathlib.Path("..") / "deploy" / "setup.sh").read_text()
    function = re.search(r"^ask_secret\(\) \{.*?^\}$", body, re.M | re.S)
    assert function, "ask_secret is no longer where this test looks for it"

    script = (
        "warn() { printf '%s\\n' \"$*\" >&2; }\n"
        + function.group(0)
        + "\nprintf %s \"$(printf 'Secret123!\\nSecret123!\\n' | ask_secret x)\"\n"
    )
    typed = subprocess.run(  # noqa: S603 - the script is this repo's own
        ["/bin/bash", "-c", script], capture_output=True, check=True
    ).stdout
    assert typed == b"Secret123!", f"the installer would set {typed!r}"


def test_network_boot_is_only_offered_where_dhcp_can_advertise_it() -> None:
    """Network boot is advertised over DHCP. Showing the section without a DHCP
    server would offer a deployment with nothing to attach it to."""
    import pathlib
    import re

    shell = (pathlib.Path("..") / "web" / "src" / "Shell.tsx").read_text()
    entry = re.search(r'to: "/enrolment".*?\}', shell, re.S)
    assert entry, "the Client Enrolment nav entry moved"
    assert '"pxe"' in entry.group(0) and '"dhcp"' in entry.group(0), entry.group(0)


def test_every_job_that_builds_the_desktop_app_installs_the_same_headers() -> None:
    """The desktop build needs an X11 *and* a Wayland toolchain, because glfw
    builds both backends on Linux. Two jobs build it; a second list that had
    drifted from the first is what broke the client package."""
    import pathlib
    import re

    workflow = (pathlib.Path("..") / ".github" / "workflows" / "ci.yml").read_text()
    # One set per line that names the GL headers. Matching whole apt-get
    # commands does not work: every following line is indented, so a greedy
    # pattern swallows the file and finds one set however wrong they are.
    installs = {
        frozenset(re.findall(r"lib[a-z0-9-]+-dev|xorg-dev", line))
        for line in workflow.splitlines()
        if "libgl1-mesa-dev" in line
    }
    assert len(installs) >= 1, "nothing builds the desktop application any more"
    assert len(installs) == 1, f"the desktop jobs install different headers: {installs}"
    (headers,) = installs
    for required in ("libwayland-dev", "libxkbcommon-dev", "xorg-dev", "libgl1-mesa-dev"):
        assert required in headers, f"{required} is missing from {sorted(headers)}"


def test_no_route_reads_a_field_the_session_does_not_have() -> None:
    """A session attribute that does not exist fails at request time, on a path
    a unit test with a fake pool never reaches. Reading the field names out of
    the source is cheaper than discovering it in production."""
    import dataclasses
    import pathlib
    import re

    from odm.sessions import Session

    fields = {field.name for field in dataclasses.fields(Session)}
    # `session` is also a local name for a login session in the agent's own
    # request models, which are pydantic. Those are the methods that reaches.
    methods = {"model_dump", "model_dump_json"}
    for path in pathlib.Path("odm").glob("*.py"):
        for attribute in re.findall(r"\bsession\.([a-z_]+)", path.read_text()):
            assert attribute in fields or attribute in methods, (
                f"{path.name} reads session.{attribute}, which is not a field: "
                f"{sorted(fields)}"
            )


def test_the_database_allows_every_task_kind_the_control_plane_queues():
    """The kind column has a check constraint, and it is easy to add a kind to
    tasks.KINDS without widening it.

    Four features did exactly that: replacing the console certificate and
    configuring a session host or broker failed with a check violation the
    moment the row was written, which reaches an operator as a 500 with
    nothing in it.
    """
    import pathlib
    import re

    from odm import tasks

    migrations = sorted(pathlib.Path("odm/migrations").glob("*.sql"))
    latest = None
    for path in migrations:
        found = re.findall(
            r"node_task_kind_check CHECK \(\s*kind IN \((.*?)\)\s*\)", path.read_text(), re.S
        )
        if found:
            latest = found[-1]
    assert latest, "no node_task kind constraint in any migration"

    allowed = set(re.findall(r"'([a-z-]+)'", latest))
    missing = sorted(set(tasks.KINDS) - allowed)
    assert not missing, f"the database would reject these task kinds: {missing}"
    extra = sorted(allowed - set(tasks.KINDS))
    assert not extra, f"the constraint allows kinds nothing queues: {extra}"


def test_the_agent_never_sends_more_than_the_control_plane_accepts():
    """A result the control plane refuses leaves the task claimed and the
    console saying "installing" with the work long finished.

    The agent keeps the tail of a long install; the API bounds what it will
    take. When those two numbers disagreed — 60000 against 8000 — every role
    whose installer printed more than 8KB stuck at "installing" for ever.
    """
    import pathlib
    import re

    from odm.routes_agent import TASK_OUTPUT_LIMIT

    stream = (
        pathlib.Path(__file__).resolve().parents[2]
        / "agent" / "internal" / "tasks" / "stream.go"
    ).read_text()
    found = re.search(r"const keepBytes = ([0-9_]+)", stream)
    assert found, "the agent's output cap moved"
    keeps = int(found.group(1).replace("_", ""))
    assert keeps <= TASK_OUTPUT_LIMIT, (
        f"the agent keeps {keeps} bytes but the control plane takes {TASK_OUTPUT_LIMIT}"
    )


def test_an_issued_certificate_may_name_any_profile_that_can_exist():
    """profile started as a fixed list of the built-in names. Profiles an
    operator defines came later, and issuing from one signed the certificate,
    returned the private key — shown once, never stored — and then failed
    writing the row. The operator got a 500 and lost the key."""
    import pathlib
    import re

    migrations = sorted(pathlib.Path("odm/migrations").glob("*.sql"))
    latest = None
    for path in migrations:
        found = re.findall(
            r"ca_certificate_profile_check\s+CHECK \((.*?)\)\s*;", path.read_text(), re.S
        )
        if found:
            latest = found[-1]
    assert latest, "no ca_certificate profile constraint in any migration"
    assert "IN (" not in latest.upper(), (
        f"the constraint is still a fixed list of names: {latest.strip()}"
    )


def test_the_control_plane_accepts_every_status_an_applier_reports():
    """One unknown word made the whole report 422, so the console showed no
    Resultant Set of Policy at all for that machine — and a report is how an
    operator finds out a setting did not apply."""
    import pathlib
    import re

    from odm.routes_agent import SettingResult

    pattern = SettingResult.model_fields["status"].metadata[0].pattern
    accepted = set(re.findall(r"[a-z]+", pattern))

    appliers = (pathlib.Path(__file__).resolve().parents[2] / "agent" / "internal" / "apply")
    used = set()
    for path in appliers.glob("*.go"):
        used.update(re.findall(r'Status:\s*"([a-z]+)"', path.read_text()))
    assert used, "no applier statuses found; did the appliers move?"
    missing = sorted(used - accepted)
    assert not missing, f"the appliers report {missing}, which the control plane refuses"
