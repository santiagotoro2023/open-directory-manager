"""Typed policy settings.

The agent runs as root and executes what this document tells it to, so the
document is validated here, at the API boundary, and not trusted anywhere
downstream: absolute paths only, no traversal, octal modes, unit and cron
shapes checked, principals restricted to a sane charset (CLAUDE.md §6).
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

MODE_RE = re.compile(r"^0?[0-7]{3}$")
UNIT_RE = re.compile(r"^[A-Za-z0-9@:_.-]{1,128}\.(service|socket|timer|target|mount|path)$")
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
# No backslashes: these land in sudoers and PAM access rules, where a
# backslash is an escape character.
PRINCIPAL_RE = re.compile(r"^%?[A-Za-z0-9._-][A-Za-z0-9._ -]{0,63}\$?$")
CRON_RE = re.compile(
    r"^(@(reboot|yearly|annually|monthly|weekly|daily|hourly)|[-0-9*/,\s]{9,100})$"
)
UNC_RE = re.compile(r"^//[A-Za-z0-9._-]{1,253}/[A-Za-z0-9._$ -]{1,80}$")

Name = Annotated[str, Field(min_length=1, max_length=64)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def absolute_path(value: str) -> str:
    if not value.startswith("/") or ".." in value.split("/") or len(value) > 4096:
        raise ValueError("must be an absolute path without '..'")
    return value


class FileDeployment(Strict):
    path: str
    content: Annotated[str, Field(max_length=1_048_576)] = ""
    mode: str = "0644"
    owner: Name = "root"
    group: Name = "root"
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("path")
    @classmethod
    def _path(cls, value: str) -> str:
        return absolute_path(value)

    @field_validator("mode")
    @classmethod
    def _mode(cls, value: str) -> str:
        if not MODE_RE.match(value):
            raise ValueError("mode must be octal, e.g. 0644")
        return value


class Script(Strict):
    trigger: Literal["startup", "shutdown", "logon", "logoff"]
    name: str
    interpreter: str = "/bin/sh"
    content: Annotated[str, Field(max_length=262_144)]
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not NAME_RE.match(value):
            raise ValueError("name may contain letters, digits, dot, dash and underscore")
        return value

    @field_validator("interpreter")
    @classmethod
    def _interpreter(cls, value: str) -> str:
        return absolute_path(value)


class SystemdUnit(Strict):
    unit: str
    state: Literal["enabled", "disabled", "masked", "started", "stopped"]
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("unit")
    @classmethod
    def _unit(cls, value: str) -> str:
        if not UNIT_RE.match(value):
            raise ValueError("not a systemd unit name")
        return value


class CronJob(Strict):
    name: str
    schedule: str
    command: Annotated[str, Field(min_length=1, max_length=1024)]
    user: Name = "root"
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not NAME_RE.match(value):
            raise ValueError("invalid cron job name")
        return value

    @field_validator("schedule")
    @classmethod
    def _schedule(cls, value: str) -> str:
        if not CRON_RE.match(value.strip()):
            raise ValueError("schedule must be five cron fields or an @keyword")
        return value.strip()


class FirewallRule(Strict):
    name: str
    action: Literal["allow", "deny"] = "allow"
    direction: Literal["in", "out"] = "in"
    protocol: Literal["tcp", "udp", "icmp", "any"] = "tcp"
    port: Annotated[int, Field(ge=1, le=65535)] | None = None
    source: str = "any"

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not NAME_RE.match(value):
            raise ValueError("invalid rule name")
        return value


class DriveMap(Strict):
    """Mounted with cifs and sec=krb5: no credential is ever stored on a client."""

    name: str
    unc: str
    mount_point: str
    for_principal: str | None = None
    options: Annotated[str, Field(max_length=256)] = ""
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("unc")
    @classmethod
    def _unc(cls, value: str) -> str:
        normalized = value.replace("\\", "/")
        if not UNC_RE.match(normalized):
            raise ValueError("share must look like //server/share")
        return normalized

    @field_validator("mount_point")
    @classmethod
    def _mount_point(cls, value: str) -> str:
        return absolute_path(value)


class SudoRule(Strict):
    name: str
    users: Annotated[list[str], Field(min_length=1, max_length=64)]
    commands: Annotated[list[str], Field(min_length=1, max_length=64)]
    run_as: Name = "ALL"
    nopasswd: bool = False

    @field_validator("users")
    @classmethod
    def _users(cls, values: list[str]) -> list[str]:
        for value in values:
            if not PRINCIPAL_RE.match(value):
                raise ValueError(f"invalid principal {value!r}")
        return values

    @field_validator("commands")
    @classmethod
    def _commands(cls, values: list[str]) -> list[str]:
        for value in values:
            if value != "ALL" and not value.startswith("/"):
                raise ValueError("commands must be absolute paths or ALL")
            if any(char in value for char in "\n\r"):
                raise ValueError("commands must be a single line")
        return values


class HbacRule(Strict):
    """Host-based access control: who may open a session, and how.

    Deny overrides allow.
    """

    principal: str
    service: Literal["local", "ssh", "rdp", "all"] = "all"
    access: Literal["allow", "deny"] = "allow"

    @field_validator("principal")
    @classmethod
    def _principal(cls, value: str) -> str:
        if not PRINCIPAL_RE.match(value):
            raise ValueError("principal must be a user name or %group")
        return value


PACKAGE_RE = re.compile(r"^[a-z0-9][a-z0-9+.-]{0,127}$")


class Package(Strict):
    """An apt package to install, upgrade or remove."""

    name: str
    state: Literal["present", "latest", "absent"] = "present"
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not PACKAGE_RE.match(value):
            raise ValueError("not a Debian package name")
        return value


class TrustedCertificate(Strict):
    """A certificate to install into the machine's system trust store."""

    name: str
    certificate_pem: Annotated[str, Field(min_length=1, max_length=32_768)]

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not NAME_RE.match(value):
            raise ValueError("invalid certificate name")
        return value

    @field_validator("certificate_pem")
    @classmethod
    def _pem(cls, value: str) -> str:
        if "-----BEGIN CERTIFICATE-----" not in value:
            raise ValueError("not a PEM certificate")
        if "PRIVATE KEY" in value:
            raise ValueError("a trust anchor must not carry a private key")
        return value


class BrowserPolicy(Strict):
    """Written to each browser's documented managed-policy location."""

    chromium: dict[str, Any] = Field(default_factory=dict)
    firefox: dict[str, Any] = Field(default_factory=dict)


FIT = Literal["none", "wallpaper", "centered", "scaled", "stretched", "zoom", "spanned"]


class Wallpaper(Strict):
    uri: Annotated[str, Field(max_length=1024)]
    picture_options: FIT = "zoom"
    for_principal: str | None = None
    # Setting a background and letting somebody change it are different
    # decisions, so they are separate here rather than implied by each other.
    allow_user_change: bool = False


class LoginScreen(Strict):
    """The greeter, before anyone has signed in.

    A machine setting, not a user one: nobody is logged in yet, so there is no
    user whose policy could apply.
    """

    banner_text: Annotated[str, Field(max_length=512)] = ""
    background_uri: Annotated[str, Field(max_length=1024)] = ""
    background_fit: FIT = "zoom"
    # Whether a signed-in person may then change their own desktop background.
    # It belongs here as well because an operator setting the greeter usually
    # means the same thing for the desktop.
    allow_user_background: bool = True
    disable_user_list: bool = False

    @field_validator("banner_text")
    @classmethod
    def _banner(cls, value: str) -> str:
        # Written into a dconf value; a newline would end the line early and a
        # quote would end the string.
        if any(character in value for character in "\n\r'"):
            raise ValueError("the banner cannot contain newlines or apostrophes")
        return value


class CertificateEnrolment(Strict):
    """A certificate this machine should hold, and keep holding.

    The subject is not written here: the agent asks for one for itself, and
    the control plane names it from the identity that asked. A policy that
    could name a subject would be a policy that could ask for anyone's.
    """

    profile: Literal["server", "client"] = "server"
    # Where the pair is written. The key is created on the machine and never
    # leaves it, so what arrives is a certificate, not a key.
    path: Annotated[str, Field(max_length=255)] = "/etc/ssl/odm"
    validity_days: Annotated[int, Field(ge=1, le=825)] = 365
    # Renewed once this much of its life is left, so an expiry never surprises
    # anyone who was not watching.
    renew_before_days: Annotated[int, Field(ge=1, le=365)] = 30

    @field_validator("path")
    @classmethod
    def _path(cls, value: str) -> str:
        if not value.startswith("/") or ".." in value:
            raise ValueError("the path must be absolute and contain no ..")
        return value.rstrip("/")


class PasswordSelfService(Strict):
    """Whether people may change their own password from the console."""

    enabled: bool = True
    # Changing a password needs the current one, always. This is about whether
    # the page is offered at all.
    minimum_length: Annotated[int, Field(ge=1, le=255)] = 12


class Printer(Strict):
    """A printer handed to a user or group."""

    name: str
    server: Annotated[str, Field(max_length=253)]
    for_principal: Annotated[str, Field(max_length=128)] = ""
    default: bool = False
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not NAME_RE.match(value):
            raise ValueError("invalid printer name")
        return value


class AlwaysOnVpn(Strict):
    """Hold a tunnel up on this machine whatever the person using it does."""

    tunnel: str
    # Refuse to route anything until the tunnel is up, so a laptop cannot leak
    # onto a coffee-shop network while it waits.
    block_until_connected: bool = False

    @field_validator("tunnel")
    @classmethod
    def _tunnel(cls, value: str) -> str:
        if not NAME_RE.match(value):
            raise ValueError("invalid tunnel name")
        return value


class AdmxSelection(Strict):
    """One imported ADMX policy, configured.

    Element values are validated for shape here; what each element means
    comes from the imported template, and the compiler ignores values whose
    element no longer exists.
    """

    policy_id: Annotated[str, Field(min_length=1, max_length=256)]
    state: Literal["enabled", "disabled"] = "enabled"
    values: dict[str, Any] = Field(default_factory=dict)

    @field_validator("values")
    @classmethod
    def _values(cls, values: dict[str, Any]) -> dict[str, Any]:
        if len(values) > 64:
            raise ValueError("too many element values")
        for key, value in values.items():
            if not NAME_RE.match(key):
                raise ValueError(f"invalid element id {key!r}")
            if isinstance(value, list):
                scalar = str | int | float | bool
                if len(value) > 512 or any(not isinstance(v, scalar) for v in value):
                    raise ValueError(f"invalid list value for {key!r}")
            elif not isinstance(value, str | int | float | bool | type(None)):
                raise ValueError(f"invalid value for {key!r}")
            elif isinstance(value, str) and len(value) > 8192:
                raise ValueError(f"value for {key!r} is too long")
        return values


class SystemUpdates(Strict):
    """Unattended apt updates.

    Rendered into the two apt configuration files unattended-upgrades reads,
    which is Debian's own mechanism for this rather than a timer of ODM's.
    """

    enabled: bool = True
    # Security updates only is the safe default: everything else can change
    # behaviour on a machine nobody is watching.
    security_only: bool = True
    schedule: Literal["daily", "weekly"] = "daily"
    auto_reboot: bool = False
    reboot_time: Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")] = "03:00"
    remove_unused: bool = True


class AgentSettings(Strict):
    refresh_minutes: Annotated[int, Field(ge=1, le=1440)] = 15


class PolicySettings(Strict):
    files: Annotated[list[FileDeployment], Field(default_factory=list, max_length=200)]
    scripts: Annotated[list[Script], Field(default_factory=list, max_length=100)]
    systemd_units: Annotated[list[SystemdUnit], Field(default_factory=list, max_length=200)]
    cron: Annotated[list[CronJob], Field(default_factory=list, max_length=100)]
    firewall: Annotated[list[FirewallRule], Field(default_factory=list, max_length=200)]
    drive_maps: Annotated[list[DriveMap], Field(default_factory=list, max_length=100)]
    sudo_rules: Annotated[list[SudoRule], Field(default_factory=list, max_length=100)]
    hbac_rules: Annotated[list[HbacRule], Field(default_factory=list, max_length=200)]
    trusted_certificates: Annotated[
        list[TrustedCertificate], Field(default_factory=list, max_length=32)
    ]
    packages: Annotated[list[Package], Field(default_factory=list, max_length=200)]
    admx: Annotated[list[AdmxSelection], Field(default_factory=list, max_length=500)]
    browser: BrowserPolicy | None = None
    wallpaper: Wallpaper | None = None
    updates: SystemUpdates | None = None
    login_screen: LoginScreen | None = None
    certificate_enrolment: Annotated[
        list[CertificateEnrolment], Field(default_factory=list, max_length=8)
    ]
    password_self_service: PasswordSelfService | None = None
    printers: Annotated[list[Printer], Field(default_factory=list, max_length=100)]
    always_on_vpn: AlwaysOnVpn | None = None
    agent: AgentSettings | None = None

    def stored(self) -> dict[str, Any]:
        """Drop empty categories so a GPO's settings show only what it sets."""
        dumped = self.model_dump(exclude_none=True)
        return {key: value for key, value in dumped.items() if value not in ([], {}, None)}


class ItemTargeting(Strict):
    """Targeting on one entry rather than the whole policy object.

    A drive map for laptops and another for desks is one policy object in
    Active Directory, not two. The fields are the same as the object's own, so
    what "matches" means does not depend on where it is written.
    """

    os: Annotated[list[Annotated[str, Field(max_length=64)]] | None, Field(default=None)] = None
    hostname_pattern: Annotated[str | None, Field(default=None, max_length=253)] = None
    security_groups: Annotated[list[str] | None, Field(default=None, max_length=64)] = None
    ip_ranges: Annotated[list[str] | None, Field(default=None, max_length=64)] = None


class Targeting(Strict):
    """Item-level targeting — the equivalent of a WMI filter."""

    os: Annotated[list[Annotated[str, Field(max_length=64)]] | None, Field(default=None)] = None
    hostname_pattern: Annotated[str | None, Field(default=None, max_length=253)] = None
    security_groups: Annotated[list[str] | None, Field(default=None, max_length=64)] = None
    ip_ranges: Annotated[list[str] | None, Field(default=None, max_length=64)] = None
