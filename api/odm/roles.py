"""Installable server roles (CLAUDE.md §3.10, §5.5).

A fresh install runs the core role — Active Directory, Group Policy and DNS.
Everything else is added afterwards from the UI. A role is a descriptor here,
an installer script under deploy/, and a UI module that lights up once the
role reports active; adding a new one means adding a descriptor and a script,
not touching the core.

Installers need root and a writable filesystem; the control plane has neither.
It runs under ProtectSystem=strict with NoNewPrivileges, which is what an
identity system should look like — and which means apt can never run from it,
sudo or no sudo. So every install is handed to the agent on the target machine,
including when that machine is the controller the console runs on. One path,
the same on every server, and the API keeps its sandbox.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

STAGING_DIR = "/var/lib/odm/tls-staging"

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
    # Named when the control plane already knows the answer: "realm", "domain"
    # or "dc_host". Asking an operator to retype the realm of the domain they
    # are signed in to is a question with one possible right answer.
    derived: str = ""


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
                optional=True,
                configuration=True,
                derived="realm",
            ),
            Argument(
                name="dns_server",
                label="DNS server to update",
                help="A domain controller holding the zones leases are written into.",
                kind="host",
                placeholder="dc1.corp.example.internal",
                optional=True,
                configuration=True,
                derived="dc_host",
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
                help="Where issued certificates and the private key are kept.",
                kind="path",
                default="/var/lib/odm/ca",
                placeholder="/var/lib/odm/ca",
                optional=True,
                configuration=True,
            ),
        ),
        packages=(),
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
                help="The interface installs are served on. The default route's when unset.",
                placeholder="eth0",
                optional=True,
                configuration=True,
            ),
            Argument(
                name="domain",
                label="Domain to join",
                kind="host",
                placeholder="corp.example.internal",
                optional=True,
                configuration=True,
                derived="domain",
            ),
            Argument(
                name="enrolment_token",
                label="Enrolment token",
                help="What installed machines join with. One is issued if you do not set it.",
                optional=True,
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
    "time": Role(
        name="time",
        title="Time",
        summary=(
            "chrony, serving the domain. Kerberos gives up on a clock more than "
            "five minutes out, so every sign-in depends on this being right."
        ),
        packages=("chrony",),
        arguments=(
            Argument(
                name="upstream",
                label="Where this machine gets the time",
                help="Space separated. Empty uses Debian's own pool.",
                placeholder="0.debian.pool.ntp.org 1.debian.pool.ntp.org",
                optional=True,
                configuration=True,
            ),
            Argument(
                name="allow",
                label="Networks that may ask it for the time",
                help="Space separated, in CIDR. Empty serves the networks this machine is on.",
                placeholder="10.0.0.0/8",
                optional=True,
                configuration=True,
            ),
        ),
        ui_section="controllers",
        notes=(
            "A domain-joined machine already asks its controller for the time, so "
            "installing this on the controllers is usually all there is to do."
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
    "session-host": Role(
        name="session-host",
        title="Remote desktop session host",
        summary=(
            "Serves desktops and published applications over RDP. Joins a "
            "collection, which is where everything about it is decided."
        ),
        packages=("xrdp", "xorgxrdp", "xfce4", "xfce4-goodies", "cifs-utils", "dbus-x11"),
        ui_section="remote-desktop",
        notes=(
            "Add it to a collection under Remote Desktop. Until it is in one it "
            "serves nobody: who may connect, which desktop and where profiles "
            "live are the collection's, not the machine's."
        ),
    ),
    "remote-desktop-broker": Role(
        name="remote-desktop-broker",
        title="Remote desktop broker",
        summary=(
            "The address people connect to. Sends each person to the host they "
            "were last on, so reconnecting resumes the session they left."
        ),
        packages=("haproxy",),
        ui_section="remote-desktop",
        notes=(
            "Create a collection under Remote Desktop and give it hosts. The "
            "broker listens on 3389 and routes by the user name the client "
            "sends, which is what makes a reconnect land back on the same host."
        ),
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
    """Validate a configuration and return the installer's argv.

    Kept as the fail-fast check a request runs before anything is recorded, so
    a bad value is a 400 rather than a role stuck in "installing" until an
    agent picks it up and refuses it.
    """
    if role.core:
        raise RoleError("the core role is always installed")
    return installer_arguments(role, config)


def derive(role: Role, config: dict[str, str], known: dict[str, str]) -> dict[str, str]:
    """Fill in the arguments the control plane can answer itself.

    The realm, the domain and a controller's name are not things to ask for:
    the console is signed in to that domain. An explicit value still wins, so
    a second DHCP server can be pointed at a different controller.
    """
    filled = dict(config)
    for argument in role.arguments:
        if not argument.derived or filled.get(argument.name):
            continue
        value = known.get(argument.derived, "")
        if value:
            filled[argument.name] = value
    return filled


def installer_arguments(role: Role, config: dict[str, str]) -> list[str]:
    """The validated flags the role's installer takes, in declared order."""
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


