"""Installable server roles (CLAUDE.md §3.10, §5.5).

A fresh install runs the core role — Active Directory, Group Policy and DNS.
Everything else is added afterwards from the UI. A role is a descriptor here,
an installer script under deploy/, and a UI module that lights up once the
role reports active; adding a new one means adding a descriptor and a script,
not touching the core.

Installers need root, and the API deliberately does not. It invokes one fixed
helper through sudo, whose sudoers drop-in names that single command, and the
role name is validated against this registry before it can become an
argument.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass, field

ROLE_HELPER = "/opt/odm/bin/odm-role-install"
INSTALL_TIMEOUT_SECONDS = 900

_ROLE_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
_ARG_RE = re.compile(r"^[A-Za-z0-9@:/._-]{1,253}$")


class RoleError(Exception):
    """The role could not be installed, or is not one ODM knows."""


@dataclass(frozen=True)
class Role:
    name: str
    title: str
    summary: str
    # Settings the operator must add to the secrets file once it is installed.
    produces_settings: tuple[str, ...] = ()
    # Installer arguments, in order, with the request field each comes from.
    arguments: tuple[str, ...] = ()
    packages: tuple[str, ...] = ()
    core: bool = False
    ui_section: str = ""
    notes: str = ""
    optional_arguments: frozenset[str] = field(default_factory=frozenset)


REGISTRY: dict[str, Role] = {
    "core": Role(
        name="core",
        title="Active Directory, Group Policy and DNS",
        summary=(
            "The domain itself: the directory, Kerberos, SYSVOL and the "
            "AD-integrated DNS zones. Always present."
        ),
        core=True,
        ui_section="directory",
    ),
    "dhcp": Role(
        name="dhcp",
        title="DHCP",
        summary=(
            "An ISC Kea failover pair with dynamic DNS into the domain's own "
            "zones, so leased hosts resolve without anyone touching DNS."
        ),
        arguments=("ha_role", "this_url", "peer_url", "realm", "dns_server"),
        packages=("kea-dhcp4-server", "kea-ctrl-agent", "kea-dhcp-ddns-server"),
        produces_settings=("ODM_KEA_URL", "ODM_KEA_USER", "ODM_KEA_PASSWORD"),
        ui_section="dhcp",
        notes=(
            "Install on both nodes of the pair — once as primary, once as "
            "standby — then add the printed ODM_KEA_* lines to the secrets file."
        ),
    ),
    "file-server": Role(
        name="file-server",
        title="File server",
        summary=(
            "Kerberos-authenticated SMB shares for drive maps. Clients mount "
            "with sec=krb5, so no share credential is ever stored."
        ),
        arguments=("share_name", "share_path", "valid_group"),
        optional_arguments=frozenset({"valid_group"}),
        packages=("samba", "acl", "attr"),
        ui_section="file-server",
        notes="Drive-map policies can point at the share as soon as it is active.",
    ),
}


def get(name: str) -> Role:
    role = REGISTRY.get(name)
    if role is None:
        raise RoleError(f"unknown role {name!r}")
    return role


def validate_name(name: str) -> str:
    if not _ROLE_RE.match(name or ""):
        raise RoleError("invalid role name")
    return name


def build_command(role: Role, config: dict[str, str]) -> list[str]:
    """Turn a validated config into the helper's argv.

    Only the arguments the descriptor declares are passed, in the order it
    declares them, and each is pattern-checked. A caller cannot introduce an
    argument the role does not have.
    """
    if role.core:
        raise RoleError("the core role is always installed")

    command = ["sudo", "-n", ROLE_HELPER, role.name]
    for argument in role.arguments:
        value = str(config.get(argument, "")).strip()
        if not value:
            if argument in role.optional_arguments:
                continue
            raise RoleError(f"{role.name} needs {argument}")
        if not _ARG_RE.match(value):
            raise RoleError(f"invalid value for {argument}")
        command += [f"--{argument.replace('_', '-')}", value]
    return command


def available() -> bool:
    return shutil.which("sudo") is not None


def install(role: Role, config: dict[str, str]) -> str:
    """Run the installer. Blocking, and slow — call it in the background."""
    command = build_command(role, config)
    try:
        completed = subprocess.run(  # noqa: S603 - fixed helper, validated argv, no shell
            command,
            capture_output=True,
            text=True,
            timeout=INSTALL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RoleError(f"installer did not complete: {exc}") from exc

    output = (completed.stdout or "") + (completed.stderr or "")
    if completed.returncode != 0:
        tail = output.strip().splitlines()[-5:]
        raise RoleError("\n".join(tail) or "installer failed")
    return output[-8000:]
