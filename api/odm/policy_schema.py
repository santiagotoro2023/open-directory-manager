"""Typed policy settings.

The agent runs as root and executes what this document tells it to, so the
document is validated here, at the API boundary, and not trusted anywhere
downstream: absolute paths only, no traversal, octal modes, unit and cron
shapes checked, principals restricted to a sane charset (CLAUDE.md §6).
"""

from __future__ import annotations

import base64
import binascii
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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
HOSTNAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,253}$")
# A MIME type and a desktop entry. Both reach files the whole machine
# reads, so neither may carry a separator or a quote.
_MIME_PART = r"[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}"
MIME_RE = re.compile(rf"^{_MIME_PART}/{_MIME_PART}$")
DESKTOP_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,119}\.desktop$")
EXTENSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,15}$")
# A kernel parameter, a font file, and a package name that may end in a *.
SYSCTL_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_*-]+)+$")
FONT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,120}\.(ttf|otf|ttc|woff2)$", re.I)
PACKAGE_GLOB_RE = re.compile(r"^[a-z0-9][a-z0-9+._-]{0,126}\*?$")

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
    # What the file manager calls it. The share's own name where this is
    # empty, so a drive is labelled without renaming the share or moving the
    # mount point.
    display_name: Annotated[str, Field(max_length=64)] = ""
    for_principal: str | None = None
    options: Annotated[str, Field(max_length=256)] = ""
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("unc")
    @classmethod
    def _unc(cls, value: str) -> str:
        normalized = value.replace("\\", "/")
        # The three ways the same share is written down. A file manager shows
        # smb://server/share and that is what gets pasted in; the mount takes
        # //server/share, so it is turned into one rather than refused.
        for prefix in ("smb://", "cifs://"):
            if normalized.lower().startswith(prefix):
                normalized = "//" + normalized[len(prefix) :]
                break
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
    # Either a location the picture is already at on every machine, or the
    # picture itself. A background is the one setting that is a file rather
    # than a value, and pointing the desktop at a path nothing ever puts a
    # picture at is the difference between a corporate background and a blank
    # blue screen — which is what it looked like until the picture could be
    # uploaded here.
    uri: Annotated[str, Field(max_length=1024)] = ""
    image: Annotated[str, Field(max_length=8_000_000)] = ""
    image_name: Annotated[str, Field(max_length=128)] = ""
    picture_options: FIT = "zoom"
    for_principal: str | None = None
    # Setting a background and letting somebody change it are different
    # decisions, so they are separate here rather than implied by each other.
    allow_user_change: bool = False

    @field_validator("image")
    @classmethod
    def _image(cls, value: str) -> str:
        return validate_image(value)

    @field_validator("image_name")
    @classmethod
    def _image_name(cls, value: str) -> str:
        return validate_image_name(value)

    @model_validator(mode="after")
    def _one_of(self) -> Wallpaper:
        if not self.uri and not self.image:
            raise ValueError("a background needs a picture or a location")
        return self


# The agent writes what arrives here to disk as root, so what arrives has to
# actually be a picture — checked by its own leading bytes, not by the name it
# was given.
IMAGE_MAGIC = (b"\x89PNG\r\n", b"\xff\xd8\xff", b"RIFF", b"GIF8", b"<?xml", b"<svg")


def validate_image(value: str) -> str:
    if not value:
        return value
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("the picture is not base64") from None
    if not raw.startswith(IMAGE_MAGIC):
        raise ValueError("that file is not a PNG, JPEG, GIF, WebP or SVG")
    return value


def validate_image_name(value: str) -> str:
    if value and not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", value):
        raise ValueError("the file name may contain letters, digits, dot, dash and underscore")
    return value


# //server/share, then any number of path segments. %username% is the whole
# point of the setting: one policy naming a different directory per person.
PROFILE_PATH_RE = re.compile(
    r"^//[A-Za-z0-9._-]{1,253}/[A-Za-z0-9._$ -]{1,80}(/[A-Za-z0-9._%-]{1,64})*$"
)


class RoamingProfile(Strict):
    """Where a person's home directory lives, instead of on each machine.

    Off unless a policy says otherwise, and a user setting rather than a
    machine one: it follows the person, not the desk. Point this and a remote
    desktop collection at the same share and somebody has one profile across
    every desktop and every session host in the domain.

    A profile that cannot be reached is never a reason somebody cannot sign
    in: the machine says so and gives them a local home for that session.
    """

    path: Annotated[str, Field(min_length=5, max_length=512)]
    # A disk image per person on the share, or the directory itself.
    #
    # The image is the default, and for the same reason Windows uses one for
    # its user profile disks rather than redirecting the folder: a desktop
    # expects a real filesystem underneath it. On a directory mounted over SMB,
    # dconf cannot rename its database into place —
    #
    #   failed to commit changes to dconf: Failed to rename file
    #   '~/.config/dconf/user.AMNSU3' to '~/.config/dconf/user'
    #
    # — so every component that saves a setting fails, and the file manager
    # never starts at all: "Failed to activate service 'org.gnome.Nautilus':
    # timed out". An ext4 image on the share has none of that, and it is the
    # same disk a remote desktop collection attaches.
    kind: Literal["disk", "directory"] = "disk"
    disk_gb: Annotated[int, Field(ge=1, le=2048)] = 10

    @field_validator("path")
    @classmethod
    def _path(cls, value: str) -> str:
        value = value.strip().replace("\\", "/").rstrip("/")
        if not PROFILE_PATH_RE.match(value):
            raise ValueError(
                "the profile path must look like //server/share or "
                "//server/share/folder/%username%"
            )
        if ".." in value.split("/"):
            raise ValueError("the profile path may not contain ..")
        placeholders = re.findall(r"%[A-Za-z]+%", value)
        if any(name != "%username%" for name in placeholders):
            raise ValueError("the only placeholder is %username%")
        return value


class LoginScreen(Strict):
    """The greeter, before anyone has signed in.

    A machine setting, not a user one: nobody is logged in yet, so there is no
    user whose policy could apply.
    """

    banner_text: Annotated[str, Field(max_length=512)] = ""
    background_uri: Annotated[str, Field(max_length=1024)] = ""
    background_image: Annotated[str, Field(max_length=8_000_000)] = ""
    background_image_name: Annotated[str, Field(max_length=128)] = ""
    background_fit: FIT = "zoom"
    # Whether a signed-in person may then change their own desktop background.
    # It belongs here as well because an operator setting the greeter usually
    # means the same thing for the desktop.
    allow_user_background: bool = True
    disable_user_list: bool = False

    @field_validator("background_image")
    @classmethod
    def _background_image(cls, value: str) -> str:
        return validate_image(value)

    @field_validator("background_image_name")
    @classmethod
    def _background_image_name(cls, value: str) -> str:
        return validate_image_name(value)

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
    """Whether people may change their own password, and what it must be."""

    enabled: bool = True
    # Changing a password needs the current one, always. This is about whether
    # the page is offered at all.
    minimum_length: Annotated[int, Field(ge=1, le=255)] = 12
    # Checked before the directory is asked, so somebody typing a password the
    # domain will refuse is told which rule they missed rather than getting
    # one flat rejection from Samba.
    require_uppercase: bool = False
    require_lowercase: bool = False
    require_digit: bool = False
    require_symbol: bool = False


class RemoteDesktopFile(Strict):
    """A connection file on somebody's desktop.

    Distributing .rdp files by hand is the part of a remote-desktop rollout
    that never finishes: whoever joins the team next has no icon, and whoever
    leaves keeps theirs. Named here against a collection and a group, the file
    arrives with the membership and goes when it goes.
    """

    # What the file is called, and what the icon says.
    name: Name
    # The broker to connect to. Filled in from the collection in the console.
    address: Annotated[str, Field(max_length=253)]
    # Which collection it is, for the label and for a published application.
    collection: Annotated[str, Field(max_length=64)] = ""
    # A published application's alias, when the collection serves one rather
    # than a whole desktop.
    application: Annotated[str, Field(max_length=128)] = ""
    full_screen: bool = True
    for_principal: Annotated[str, Field(max_length=128)] = ""
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("address")
    @classmethod
    def _address(cls, value: str) -> str:
        if not HOSTNAME_RE.match(value):
            raise ValueError("the address must be a host name")
        return value


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


class DefaultApplication(Strict):
    """Which program opens a kind of file.

    A machine setting: the association lives in the machine's own XDG
    configuration, and a file type that opens one program for one person and
    another for the next is a support call rather than a policy.
    """

    mime_type: Annotated[str, Field(min_length=3, max_length=128)]
    application: Annotated[str, Field(min_length=9, max_length=128)]
    # Extensions the machine may not already know — .rdp is not in
    # shared-mime-info, so without this nothing can be the default for it.
    extensions: Annotated[str, Field(max_length=128)] = ""
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("mime_type")
    @classmethod
    def _mime(cls, value: str) -> str:
        if not MIME_RE.match(value):
            raise ValueError("must be a MIME type, for example application/x-rdp")
        return value

    @field_validator("application")
    @classmethod
    def _application(cls, value: str) -> str:
        if not DESKTOP_RE.match(value):
            raise ValueError(
                "must be a desktop entry, for example org.remmina.Remmina.desktop"
            )
        return value

    @field_validator("extensions")
    @classmethod
    def _extensions(cls, value: str) -> str:
        for part in value.split(","):
            part = part.strip().lstrip(".")
            if part and not EXTENSION_RE.match(part):
                raise ValueError(f"{part!r} is not a file extension")
        return value


class DashLayout(Strict):
    """What is pinned to the dash, and in what order.

    A user setting, so one function group's layout is not another's — the same
    shape as a drive map, and for the same reason: it is decided by who is
    signing in rather than by the machine they signed in to.
    """

    name: Name
    # Desktop entries in the order they should appear.
    applications: Annotated[str, Field(min_length=1, max_length=1024)]
    for_principal: Annotated[str, Field(max_length=128)] = ""
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("applications")
    @classmethod
    def _applications(cls, value: str) -> str:
        entries = [part.strip() for part in value.split(",") if part.strip()]
        if not entries:
            raise ValueError("name at least one application")
        cleaned = []
        for entry in entries:
            if not entry.endswith(".desktop"):
                entry += ".desktop"
            if not DESKTOP_RE.match(entry):
                raise ValueError(f"{entry!r} is not a desktop entry")
            cleaned.append(entry)
        return ", ".join(cleaned)


class PowerSettings(Strict):
    """When a machine turns its screen off, when it suspends, and what the lid
    and the power button do.

    A machine setting: it is a property of the hardware in front of somebody,
    not of who they are, and a laptop that suspends mid-presentation is the
    same support call whoever is signed in.
    """

    # Minutes. 0 is never, as it is everywhere else in the policy.
    screen_off_ac_minutes: Annotated[int, Field(ge=0, le=1440)] = 10
    screen_off_battery_minutes: Annotated[int, Field(ge=0, le=1440)] = 5
    suspend_ac_minutes: Annotated[int, Field(ge=0, le=1440)] = 0
    suspend_battery_minutes: Annotated[int, Field(ge=0, le=1440)] = 30
    lid_close_action: Literal["suspend", "hibernate", "lock", "ignore"] = "suspend"
    power_button_action: Literal["suspend", "hibernate", "poweroff", "lock", "ignore"] = "suspend"
    # Whether somebody signed in may then change any of it.
    allow_user_change: bool = False


class ScreenLock(Strict):
    """When the screen locks itself, and whether it may be turned off."""

    # Minutes of inactivity before the screen blanks. 0 never blanks, which
    # also means it never locks on idle.
    idle_minutes: Annotated[int, Field(ge=0, le=1440)] = 10
    # Seconds after blanking before the lock actually engages, which is the
    # grace period somebody who moves the mouse straight back relies on.
    lock_delay_seconds: Annotated[int, Field(ge=0, le=3600)] = 0
    lock_enabled: bool = True
    lock_on_suspend: bool = True
    # Whether the lock screen shows the contents of notifications.
    show_notifications: bool = False
    allow_user_change: bool = False


class RemovableStorage(Strict):
    """What may be done with a disk somebody plugs in.

    Enforced through udisks, which is what every desktop file manager mounts
    with, and through udev for the read-only case.
    """

    mode: Literal["allow", "read_only", "block"] = "allow"
    # Accounts and groups this does not apply to, in the usual %group form.
    exempt_principals: Annotated[
        list[Annotated[str, Field(max_length=128)]], Field(default_factory=list, max_length=32)
    ]
    message: Annotated[str, Field(max_length=256)] = ""

    @field_validator("exempt_principals")
    @classmethod
    def _exempt(cls, value: list[str]) -> list[str]:
        for principal in value:
            if not PRINCIPAL_RE.match(principal):
                raise ValueError(f"{principal!r} is not a user or %group")
        return value


class SysctlSetting(Strict):
    """One kernel parameter, as sysctl names it."""

    key: Annotated[str, Field(min_length=3, max_length=128)]
    value: Annotated[str, Field(min_length=1, max_length=128)]
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("key")
    @classmethod
    def _key(cls, value: str) -> str:
        if not SYSCTL_RE.match(value):
            raise ValueError("must be a sysctl name, for example net.ipv4.ip_forward")
        return value

    @field_validator("value")
    @classmethod
    def _value(cls, value: str) -> str:
        # It lands in a configuration file one setting per line.
        if any(character in value for character in "\n\r"):
            raise ValueError("a value cannot span lines")
        return value


class Shortcut(Strict):
    """An icon on somebody's desktop, an entry in their menu, or a place in
    their file manager."""

    name: Name
    kind: Literal["application", "link", "place"] = "link"
    # A command for an application, a URL for a link, a path or URI for a place.
    target: Annotated[str, Field(min_length=1, max_length=1024)]
    icon: Annotated[str, Field(max_length=128)] = ""
    where: Literal["desktop", "menu", "both"] = "desktop"
    for_principal: Annotated[str, Field(max_length=128)] = ""
    # Optional: this entry applies only where it matches.
    targeting: ItemTargeting | None = None

    @field_validator("target")
    @classmethod
    def _target(cls, value: str) -> str:
        # It is written into a desktop entry, one key per line.
        if any(character in value for character in "\n\r"):
            raise ValueError("a target cannot span lines")
        return value

    @model_validator(mode="after")
    def _shape(self) -> Shortcut:
        if self.kind == "link" and not self.target.startswith(
            ("http://", "https://", "smb://", "ftp://", "sftp://", "mailto:")
        ):
            raise ValueError("a link needs a URL, for example https://intranet.example.org")
        if self.kind == "application" and not self.target.startswith("/"):
            raise ValueError("an application needs the absolute path of the program to run")
        if self.kind == "place" and not (
            self.target.startswith("/") or "://" in self.target
        ):
            raise ValueError("a place needs a path or a URI, for example smb://fs01/shared")
        if self.kind == "place" and self.where != "desktop":
            # A place lives in the file manager's sidebar; there is nowhere
            # else for it to be.
            self.where = "desktop"
        return self


class Font(Strict):
    """A font file installed on the machine for everybody."""

    name: Annotated[str, Field(min_length=1, max_length=128)]
    # The file itself, base64, so the machines it is for receive it rather
    # than being pointed at a path nobody put it at.
    content: Annotated[str, Field(max_length=8_000_000)]

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not FONT_RE.match(value):
            raise ValueError("must be a font file name ending in .ttf, .otf, .ttc or .woff2")
        return value

    @field_validator("content")
    @classmethod
    def _content(cls, value: str) -> str:
        try:
            base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("the font must be base64") from exc
        return value


class DesktopTheme(Strict):
    """How the desktop looks: theme, icons, cursor and the interface font."""

    gtk_theme: Annotated[str, Field(max_length=64)] = ""
    icon_theme: Annotated[str, Field(max_length=64)] = ""
    cursor_theme: Annotated[str, Field(max_length=64)] = ""
    # As GTK writes it: a family, a style and a size — "Inter 11".
    interface_font: Annotated[str, Field(max_length=64)] = ""
    document_font: Annotated[str, Field(max_length=64)] = ""
    monospace_font: Annotated[str, Field(max_length=64)] = ""
    colour_scheme: Literal["", "default", "prefer-dark", "prefer-light"] = ""
    allow_user_change: bool = True

    @model_validator(mode="after")
    def _names(self) -> DesktopTheme:
        for value in (
            self.gtk_theme,
            self.icon_theme,
            self.cursor_theme,
            self.interface_font,
            self.document_font,
            self.monospace_font,
        ):
            # These are written into a dconf keyfile as quoted strings.
            if any(character in value for character in "\n\r'"):
                raise ValueError("a theme or font name cannot contain newlines or apostrophes")
        return self


class SecondFactor(Strict):
    """A second factor at the machine, not only at the console.

    The code is checked by the control plane against the enrolment somebody
    already made for the console, so one enrolment covers both and no secret
    is ever written to a machine.
    """

    enabled: bool = True
    # Whether somebody with no second factor is walked through setting one up
    # at the machine, rather than being sent to an administrator. On by
    # default: the alternative is a person who cannot sign in and a ticket.
    self_enrol: bool = True
    # Which ways in ask for it.
    services: Annotated[
        list[Literal["login", "ssh", "sudo", "remote-desktop"]],
        Field(default_factory=lambda: ["login", "ssh"], max_length=4),
    ]
    # Who has to have one. Empty is everybody the policy reaches.
    require_principals: Annotated[
        list[Annotated[str, Field(max_length=128)]], Field(default_factory=list, max_length=64)
    ]
    exempt_principals: Annotated[
        list[Annotated[str, Field(max_length=128)]], Field(default_factory=list, max_length=64)
    ]
    # Somebody who has not enrolled yet is let in for this long after the
    # setting first reaches them. 0 refuses them from the first sign-in.
    grace_days: Annotated[int, Field(ge=0, le=365)] = 14

    @field_validator("require_principals", "exempt_principals")
    @classmethod
    def _principals(cls, value: list[str]) -> list[str]:
        for principal in value:
            if not PRINCIPAL_RE.match(principal):
                raise ValueError(f"{principal!r} is not a user or %group")
        return value


class FirstRun(Strict):
    """What a person is shown the first time they sign in to a machine.

    A managed desktop has already been set up by whoever manages it, so the
    distribution's own welcome tour is asking somebody to choose things that
    are not theirs to choose.
    """

    disable_tour: bool = True
    disable_welcome_dialog: bool = True
    # A message of the day, for the estates that want one. Empty writes none.
    message: Annotated[str, Field(max_length=2048)] = ""


class SoftwareControl(Strict):
    """Which software may be installed on the machine.

    New packages are refused unless they are on the list. Upgrading something
    already installed is always allowed, so security updates and the packages
    ODM deploys keep working.
    """

    enabled: bool = True
    # Package names. A trailing * matches a prefix, which is how a family of
    # packages is named without listing every one of them.
    allowed: Annotated[
        list[Annotated[str, Field(max_length=128)]], Field(default_factory=list, max_length=500)
    ]
    block_flatpak: bool = True
    block_snap: bool = True
    message: Annotated[str, Field(max_length=256)] = ""

    @field_validator("allowed")
    @classmethod
    def _allowed(cls, value: list[str]) -> list[str]:
        for name in value:
            if not PACKAGE_GLOB_RE.match(name):
                raise ValueError(f"{name!r} is not a package name")
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


class RemoteDesktopSession(Strict):
    """What a remote desktop session may carry between client and host.

    Not on the collection, because it is not a property of who connects to
    what: it is a rule about machines, and an organisation usually wants the
    same rule everywhere and one exception for a group. That is what a policy
    object linked at an OU is for.
    """

    allow_clipboard: bool = True
    allow_printers: bool = True
    # Off by default. A redirected drive is the client's filesystem inside the
    # session, which is the usual way data leaves a managed desktop.
    allow_drives: bool = False
    allow_audio: bool = True
    allow_microphone: bool = False
    max_colour_depth: Annotated[int, Field(ge=8, le=32)] = 32


class LocalAdministrator(Strict):
    """A local administrator whose password the machine rotates itself.

    Active Directory calls this LAPS. The point is that every machine has a
    working local account for when the domain is unreachable, and that the
    password is different on every machine — so one recovered from a stolen
    laptop opens nothing else. The machine generates it, reports it to the
    control plane over its authenticated channel, and rotates it on a
    schedule. Nobody types it in, and it is never in a policy object.
    """

    account: Annotated[str, Field(min_length=1, max_length=32)] = "odmadmin"
    rotate_days: Annotated[int, Field(ge=1, le=365)] = 30
    length: Annotated[int, Field(ge=12, le=128)] = 20
    # Whether the account may use sudo. Off makes it a way in, not a way up.
    administrator: bool = True

    @field_validator("account")
    @classmethod
    def _valid_account(cls, value: str) -> str:
        if not re.fullmatch(r"[a-z_][a-z0-9_-]*", value):
            raise ValueError("not a valid local account name")
        return value


class LocalPasswordPolicy(Strict):
    """Password rules for accounts that live on the machine itself.

    Domain accounts are not covered by this and cannot be: their rules are
    held on the domain object and enforced by the directory on every change,
    wherever it is made. This is pam_pwquality and login.defs — what a local
    password may be, and how long it lasts.
    """

    minimum_length: Annotated[int, Field(ge=6, le=128)] = 12
    require_uppercase: bool = False
    require_lowercase: bool = False
    require_digit: bool = False
    require_symbol: bool = False
    # 0 leaves the machine's own value alone rather than setting "never":
    # a policy that stops applying must not leave an age behind it.
    maximum_age_days: Annotated[int, Field(ge=0, le=3650)] = 0
    minimum_age_days: Annotated[int, Field(ge=0, le=365)] = 0
    warn_days: Annotated[int, Field(ge=0, le=365)] = 7
    # Which accounts the ages are applied to. Empty means every local account
    # outside the system range; naming accounts narrows it to those.
    accounts: Annotated[list[Name], Field(default_factory=list, max_length=64)]


class AgentUpdate(Strict):
    """Whether machines take the agent this console hands out.

    The agent is what makes every other remote job possible, so the version a
    machine is on decides which of them work — and updating it by signing in
    to each machine is the one job that most wants doing remotely.

    Off by default. A domain that has not asked for this keeps every agent
    exactly where it is, which is what a machine should do about software
    replacing itself.
    """

    # notify: the machine reports what it is on and what is available, and
    # changes nothing — the console shows which machines are behind.
    # install: it takes the update at its next refresh.
    mode: Literal["off", "notify", "install"] = "off"
    # Empty follows whatever this console hands out, which is what "latest"
    # means in a domain that serves its own agent. A version pins it, in both
    # directions: a machine ahead of it comes back to it.
    version: Annotated[str, Field(default="", max_length=32, pattern=r"^(\d+\.\d+\.\d+)?$")] = ""


class AgentSettings(Strict):
    """Kept so a policy object written before the interval became a domain
    setting still reads and still exports. The interval now comes from the
    domain (Domain Controllers → Agents) and nothing else: two places to set
    one thing meant a console that said 5 minutes over a machine polling on
    15. Values here are ignored."""

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
    roaming_profile: RoamingProfile | None = None
    updates: SystemUpdates | None = None
    login_screen: LoginScreen | None = None
    certificate_enrolment: Annotated[
        list[CertificateEnrolment], Field(default_factory=list, max_length=8)
    ]
    password_self_service: PasswordSelfService | None = None
    local_password_policy: LocalPasswordPolicy | None = None
    printers: Annotated[list[Printer], Field(default_factory=list, max_length=100)]
    remote_desktop_files: Annotated[
        list[RemoteDesktopFile], Field(default_factory=list, max_length=50)
    ]
    default_applications: Annotated[
        list[DefaultApplication], Field(default_factory=list, max_length=200)
    ]
    sysctl: Annotated[list[SysctlSetting], Field(default_factory=list, max_length=200)]
    shortcuts: Annotated[list[Shortcut], Field(default_factory=list, max_length=100)]
    fonts: Annotated[list[Font], Field(default_factory=list, max_length=50)]
    power: PowerSettings | None = None
    screen_lock: ScreenLock | None = None
    removable_storage: RemovableStorage | None = None
    desktop_theme: DesktopTheme | None = None
    second_factor: SecondFactor | None = None
    first_run: FirstRun | None = None
    software_control: SoftwareControl | None = None
    dash: Annotated[list[DashLayout], Field(default_factory=list, max_length=50)]
    always_on_vpn: AlwaysOnVpn | None = None
    local_administrator: LocalAdministrator | None = None
    remote_desktop_session: RemoteDesktopSession | None = None
    agent: AgentSettings | None = None
    agent_update: AgentUpdate | None = None

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
