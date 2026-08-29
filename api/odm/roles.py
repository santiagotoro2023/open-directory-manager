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
from dataclasses import dataclass
from pathlib import Path

# Absolute, so the helper cannot be shadowed by anything on PATH.
SUDO = shutil.which("sudo") or "/usr/bin/sudo"
ROLE_HELPER = "/opt/odm/bin/odm-role-install"
CONSOLE_CERT_HELPER = "/opt/odm/bin/odm-apply-console-certificate"
STAGING_DIR = "/var/lib/odm/tls-staging"
INSTALL_TIMEOUT_SECONDS = 900
HELPER_TIMEOUT_SECONDS = 60

_ROLE_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
_ARG_RE = re.compile(r"^[A-Za-z0-9@:/._-]{1,253}$")

# Some values legitimately contain characters the default pattern refuses: a
# distinguished name has commas, equals signs and spaces; a crypt(3) hash has
# dollars and slashes. Each kind is checked against what it may actually be,
# rather than the loosest pattern that would let all of them through.
_ARG_PATTERNS: dict[str, re.Pattern[str]] = {
    "dn": re.compile(r"^[A-Za-z0-9=,._ -]{3,512}$"),
    # $6$rounds=5000$salt$hash — the rounds prefix is optional but legal.
    "hash": re.compile(r"^[A-Za-z0-9$./=]{1,255}$"),
    # A comma-separated list of network addresses.
    "networks": re.compile(r"^[0-9./,]{7,255}$"),
}


class RoleError(Exception):
    """The role could not be installed, or is not one ODM knows."""


@dataclass(frozen=True)
class Argument:
    """One installer argument, described well enough to render a real field.

    The console used to title-case the argument name, which produced "Ha role"
    and "This url" and told the operator nothing about what to type.
    """

    name: str
    label: str
    help: str = ""
    # text | choice | url | host | path | dn | hash | networks — decides the
    # control the console draws, and which characters the value may contain.
    kind: str = "text"
    choices: tuple[str, ...] = ()
    placeholder: str = ""
    default: str = ""
    optional: bool = False
    # Set once the role exists, from the section that manages the service,
    # rather than asked for while installing it.
    configuration: bool = False


@dataclass(frozen=True)
class Role:
    name: str
    title: str
    summary: str
    # Settings the operator must add to the secrets file once it is installed.
    produces_settings: tuple[str, ...] = ()
    # Installer arguments, in order, with the request field each comes from.
    arguments: tuple[Argument, ...] = ()
    packages: tuple[str, ...] = ()
    core: bool = False
    ui_section: str = ""
    notes: str = ""


REGISTRY: dict[str, Role] = {
    "core": Role(
        name="core",
        title="Directory, Group Policy and DNS",
        summary="The directory, Kerberos, SYSVOL and the domain's DNS zones.",
        core=True,
        ui_section="directory",
    ),
    "dhcp": Role(
        name="dhcp",
        title="DHCP",
        summary="An ISC Kea failover pair that registers its leases in the domain's DNS zones.",
        arguments=(
            Argument(
                name="ha_role",
                label="Failover role",
                help="This node's part in the pair. Leave unset for a single server.",
                kind="choice",
                choices=("primary", "standby"),
                optional=True,
                configuration=True,
            ),
            Argument(
                name="this_url",
                label="Failover address of this node",
                kind="url",
                placeholder="http://dhcp1.corp.example.internal:8080/",
                optional=True,
                configuration=True,
            ),
            Argument(
                name="peer_url",
                label="Failover address of the other node",
                kind="url",
                placeholder="http://dhcp2.corp.example.internal:8080/",
                optional=True,
                configuration=True,
            ),
            Argument(
                name="realm",
                label="Kerberos realm",
                kind="text",
                placeholder="CORP.EXAMPLE.INTERNAL",
            ),
            Argument(
                name="dns_server",
                label="DNS server to update",
                help="A domain controller holding the zones leases are written into.",
                kind="host",
                placeholder="dc1.corp.example.internal",
            ),
        ),
        packages=("kea-dhcp4-server", "kea-ctrl-agent", "kea-dhcp-ddns-server"),
        produces_settings=("ODM_KEA_URL", "ODM_KEA_USER", "ODM_KEA_PASSWORD"),
        ui_section="dhcp",
        notes=(
            "Add the ODM_KEA_* lines the installer prints to the secrets file. "
            "Pair two nodes for failover under DHCP once both are installed."
        ),
    ),
    "certificate-authority": Role(
        name="certificate-authority",
        title="Certificate authority",
        summary=(
            "Issues server and client certificates, publishes its root through group "
            "policy, and re-issues the console's own certificate."
        ),
        arguments=(
            Argument(
                name="ca_dir",
                label="Storage directory",
                kind="path",
                default="/var/lib/odm/ca",
                placeholder="/var/lib/odm/ca",
                optional=True,
            ),
        ),
        packages=(),
        produces_settings=("ODM_CA_DIR",),
        ui_section="ca",
        notes="Create the root under Certificates once this is installed, then publish it.",
    ),
    "pxe": Role(
        name="pxe",
        title="Client enrolment (PXE)",
        summary=(
            "Unattended Debian installation over the network. Installed machines "
            "join the domain on first boot with an enrolment token."
        ),
        arguments=(
            Argument(
                name="interface",
                label="Network interface",
                help="The interface installs are served on.",
                placeholder="eth0",
            ),
            Argument(
                name="domain",
                label="Domain to join",
                kind="host",
                placeholder="corp.example.internal",
            ),
            Argument(
                name="enrolment_token",
                label="Enrolment token",
                help="A multi-use token, created under Directory.",
                configuration=True,
            ),
            Argument(
                name="suite",
                label="Debian release",
                help="Which release is installed. The netboot image is fetched for it.",
                kind="choice",
                choices=("trixie", "bookworm"),
                default="trixie",
                optional=True,
                configuration=True,
            ),
            Argument(
                name="mirror",
                label="Mirror",
                help=(
                    "A snapshot.debian.org URL installs a fixed point release; "
                    "the default installs whatever the release currently is."
                ),
                kind="url",
                default="http://deb.debian.org/debian",
                optional=True,
                configuration=True,
            ),
            Argument(
                name="ou",
                label="Container for installed machines",
                help="Where the computer account is created. The default container when empty.",
                kind="dn",
                placeholder="OU=Workstations,DC=corp,DC=example,DC=internal",
                optional=True,
                configuration=True,
            ),
            Argument(
                name="local_admin",
                label="Local administrator account",
                help="Created on every installed machine, for when a join does not finish.",
                default="localadmin",
                optional=True,
                configuration=True,
            ),
            Argument(
                name="local_password_hash",
                label="Local administrator password hash",
                help="crypt(3), as openssl passwd -6 produces. One is generated when empty.",
                kind="hash",
                optional=True,
                configuration=True,
            ),
            Argument(
                name="scopes",
                label="Networks to offer boot on",
                help=(
                    "DHCP scopes network boot is advertised in. Machines on any other "
                    "network are not offered it at all."
                ),
                kind="networks",
                placeholder="10.10.0.0,10.20.0.0",
                optional=True,
                configuration=True,
            ),
            Argument(
                name="client_binary",
                label="Client installer",
                help="Path to odm-client-install on the PXE server. Published to installs.",
                kind="path",
                default="/usr/sbin/odm-client-install",
                optional=True,
                configuration=True,
            ),
        ),
        packages=("dnsmasq", "nginx-light"),
        ui_section="pxe",
        notes=(
            "Runs as proxy DHCP, so address assignment stays with the DHCP role or an "
            "existing server. Set which release to install, and where joined machines "
            "land, under Client Enrolment."
        ),
    ),
    "print-server": Role(
        name="print-server",
        title="Print server",
        summary="CUPS printers, published to the domain and handed to clients by policy.",
        packages=("cups", "cups-ipp-utils", "printer-driver-all", "avahi-daemon"),
        ui_section="printers",
        notes="Add the printers themselves under Printers once this is installed.",
    ),
    "radius": Role(
        name="radius",
        title="Network access (RADIUS)",
        summary=(
            "FreeRADIUS against the directory, for wired and wireless "
            "authentication and for VPN sign-in."
        ),
        packages=("freeradius", "freeradius-utils", "krb5-user", "winbind"),
        ui_section="radius",
        notes=(
            "Add the devices that ask, and the rules that decide, under Network "
            "Access once this is installed."
        ),
    ),
    "vpn": Role(
        name="vpn",
        title="Remote access (VPN)",
        summary="WireGuard tunnels for machines and people outside the network.",
        packages=("wireguard-tools", "iptables"),
        arguments=(
            Argument(
                name="external_interface",
                label="Interface facing the internet",
                help="Traffic from the tunnel is routed out through this.",
                placeholder="eth0",
                optional=True,
                configuration=True,
            ),
        ),
        ui_section="vpn",
        notes="Create the tunnels themselves under Remote Access once this is installed.",
    ),
    "file-server": Role(
        name="file-server",
        title="File server",
        summary="Kerberos-authenticated SMB shares for drive maps.",
        packages=("samba", "acl", "attr"),
        ui_section="file-server",
        notes="Create the shares themselves under File Shares once this is installed.",
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

    return [SUDO, "-n", ROLE_HELPER, role.name, *installer_arguments(role, config)]


def installer_arguments(role: Role, config: dict[str, str]) -> list[str]:
    """The validated flags the role's installer takes, in declared order.

    Separate from build_command because a role installed on another machine is
    run by that machine's agent, which needs the arguments without this host's
    sudo wrapper around them.
    """
    command: list[str] = []
    for argument in role.arguments:
        value = str(config.get(argument.name, "")).strip() or argument.default
        if not value:
            if argument.optional:
                continue
            raise RoleError(f"{role.name} needs {argument.label.lower()}")
        if not _ARG_PATTERNS.get(argument.kind, _ARG_RE).match(value):
            raise RoleError(f"invalid value for {argument.label.lower()}")
        if argument.choices and value not in argument.choices:
            allowed = ", ".join(argument.choices)
            raise RoleError(f"{argument.label.lower()} must be one of {allowed}")
        command += [f"--{argument.name.replace('_', '-')}", value]
    return command


def available() -> bool:
    return shutil.which("sudo") is not None


def stage_console_certificate(settings, certificate_pem: str, private_key_pem: str) -> None:
    """Write the console's new certificate where the helper will find it."""
    if not private_key_pem:
        raise RoleError("no private key was generated for the console certificate")
    staging = Path(STAGING_DIR)
    staging.mkdir(parents=True, exist_ok=True)
    staging.chmod(0o700)

    key_file = staging / "console.key"
    key_file.touch(mode=0o600, exist_ok=True)
    key_file.chmod(0o600)
    key_file.write_text(private_key_pem, encoding="ascii")

    cert_file = staging / "console.crt"
    cert_file.write_text(certificate_pem, encoding="ascii")
    cert_file.chmod(0o644)


def apply_console_certificate() -> bool:
    """Ask the privileged helper to install the staged pair and restart.

    Returns False when the helper is not installed, so the console can tell
    the operator to install it rather than reporting a silent success.
    """
    if not Path(CONSOLE_CERT_HELPER).exists():
        return False
    try:
        completed = subprocess.run(  # noqa: S603 - fixed helper, no arguments, no shell
            [SUDO, "-n", CONSOLE_CERT_HELPER],
            capture_output=True,
            text=True,
            timeout=HELPER_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RoleError(f"could not apply the console certificate: {exc}") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip().splitlines()[-3:]
        raise RoleError("\n".join(detail) or "the helper refused the certificate")
    return True


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
