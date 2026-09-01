"""DNS management on Samba's AD-integrated DNS (CLAUDE.md §3.7).

Records live in the directory as binary dnsRecord blobs. Rather than
implement that wire format — which would be exactly the kind of custom
protocol code §6 rules out — ODM drives `samba-tool dns`, which is the
supported interface to the same data, authenticating with the API's own
Kerberos credentials.

Every argument is validated against a strict pattern and passed as an argv
element; nothing is ever handed to a shell.
"""

from __future__ import annotations

import ipaddress
import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any

from .config import Settings

SAMBA_TOOL = "samba-tool"
TIMEOUT_SECONDS = 30

RECORD_TYPES = ("A", "AAAA", "CNAME", "MX", "NS", "PTR", "SRV", "TXT")

# Underscores are legal here: Active Directory provisions _msdcs.<domain> as a
# zone of its own, and rejecting it made the domain's own zone unreadable.
_ZONE_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?"
                      r"(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?)*$")
_NAME_RE = re.compile(r"^(@|\*|[A-Za-z0-9_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?"
                      r"(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?)*)$")
_HOST_RE = re.compile(r"^(?=.{1,254}$)[A-Za-z0-9_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?"
                      r"(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?)*\.?$")
_TXT_RE = re.compile(r'^[^\x00-\x1f"\\]{0,255}$')

# "    A: 10.0.0.10 (flags=f0, serial=1, ttl=900)"
_RECORD_RE = re.compile(
    r"^\s*(?P<type>[A-Z]+):\s*(?P<data>.*?)\s*\(flags=(?P<flags>[0-9a-fx]+),"
    r"\s*serial=(?P<serial>\d+),\s*ttl=(?P<ttl>\d+)\)\s*$"
)
# "  Name=dc1, Records=1, Children=0"
_NODE_RE = re.compile(r"^\s*Name=(?P<name>[^,]*),\s*Records=(?P<records>\d+)")


class DnsError(Exception):
    """samba-tool refused the operation, or is not available."""


class DnsUnavailable(DnsError):
    """This host cannot manage DNS — samba-tool is not installed here."""


@dataclass(frozen=True)
class Record:
    name: str
    type: str
    data: str
    ttl: int
    serial: int
    flags: str

    def as_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "type": self.type,
            "data": self.data,
            "ttl": self.ttl,
            "serial": self.serial,
            "flags": self.flags,
        }


def available() -> bool:
    return shutil.which(SAMBA_TOOL) is not None


def validate_zone(zone: str) -> str:
    zone = zone.strip().rstrip(".")
    if not _ZONE_RE.match(zone):
        raise DnsError(f"invalid zone name {zone!r}")
    return zone


def validate_name(name: str) -> str:
    name = name.strip()
    if not _NAME_RE.match(name):
        raise DnsError(f"invalid record name {name!r}")
    return name


def validate_type(record_type: str) -> str:
    record_type = record_type.strip().upper()
    if record_type not in RECORD_TYPES:
        raise DnsError(f"unsupported record type {record_type!r}")
    return record_type


def validate_data(record_type: str, data: str) -> str:
    """Reject anything that is not well formed for its record type."""
    data = data.strip()
    if not data or len(data) > 512:
        raise DnsError("record data is empty or too long")

    if record_type == "A":
        return str(ipaddress.IPv4Address(data)) if _ipv4(data) else _bad(data)
    if record_type == "AAAA":
        return str(ipaddress.IPv6Address(data)) if _ipv6(data) else _bad(data)
    if record_type in ("CNAME", "NS", "PTR"):
        if not _HOST_RE.match(data):
            _bad(data)
        return data
    if record_type == "MX":
        preference, _, host = data.partition(" ")
        if not preference.isdigit() or int(preference) > 65535 or not _HOST_RE.match(host.strip()):
            raise DnsError("MX data must be '<preference> <host>'")
        return f"{int(preference)} {host.strip()}"
    if record_type == "SRV":
        parts = data.split()
        if len(parts) != 4 or not all(part.isdigit() for part in parts[:3]):
            raise DnsError("SRV data must be '<priority> <weight> <port> <target>'")
        if not _HOST_RE.match(parts[3]):
            _bad(parts[3])
        return " ".join(parts)
    if record_type == "TXT":
        text = data.strip('"')
        if not _TXT_RE.match(text):
            raise DnsError("TXT data contains characters that cannot be represented")
        return text
    return _bad(data)


def _ipv4(value: str) -> bool:
    try:
        ipaddress.IPv4Address(value)
    except ValueError:
        return False
    return True


def _ipv6(value: str) -> bool:
    try:
        ipaddress.IPv6Address(value)
    except ValueError:
        return False
    return True


def _bad(value: str) -> str:
    raise DnsError(f"invalid record data {value!r}")


def _run(settings: Settings, *args: str) -> str:
    """Run samba-tool with the API's Kerberos credentials. Blocking."""
    if not available():
        raise DnsUnavailable(
            "samba-tool is not installed on the API host; DNS management requires "
            "the control plane to run on a domain controller"
        )
    command = [SAMBA_TOOL, "dns", *args, "-k", "yes"]
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, validated arguments
            command,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DnsError(f"samba-tool dns failed: {exc}") from exc
    if completed.returncode != 0:
        raise DnsError(message(completed.stderr, completed.stdout, "samba-tool dns failed"))
    return completed.stdout


def server(settings: Settings) -> str:
    """The DC samba-tool talks to."""
    return settings.ldap_uri.removeprefix("ldaps://").split(":")[0]


# Lines of a Python traceback that carry no message: the frame headers and
# the ~~~^^^ marker Python 3.11 draws under the expression that raised.
_NOISE = re.compile(r'^(Traceback \(most recent call last\):|[~^ ]+|\.\.\.)$')


def message(stderr: str, stdout: str, fallback: str) -> str:
    """The line of samba-tool output worth putting in front of an operator.

    samba-tool reports a failure by letting a Python traceback out. Taking its
    last line — the obvious thing — gives the marker under the failing
    expression, so the console showed a row of tildes and carets where the
    error should have been.
    """
    useful = [
        line.strip()
        for line in (stderr or stdout or "").splitlines()
        # An indented line is a traceback frame or its source; the exception
        # itself, and every ERROR() samba-tool prints, start at column zero.
        if line.strip() and not line.startswith((" ", "\t")) and not _NOISE.match(line.strip())
    ]
    return useful[-1] if useful else fallback


def connection_flags(settings: Settings) -> list[str]:
    """Reach the directory over the wire, as the control plane's account.

    Without these samba-tool opens /var/lib/samba/private/sam.ldb directly,
    which only root may read — and the control plane deliberately does not run
    as root. Every subcommand that took this path failed with "Unable to open
    tdb ... Permission denied" rather than doing its work over LDAP the way
    the DNS commands already did.
    """
    return ["-H", settings.ldap_uri, "-k", "yes"]


# ------------------------------------------------------------------- zones ---


def list_zones(settings: Settings) -> list[dict[str, Any]]:
    output = _run(settings, "zonelist", server(settings))
    zones: list[dict[str, Any]] = []
    current: dict[str, Any] = {}
    for line in output.splitlines():
        stripped = line.strip()
        if stripped.startswith("pszZoneName"):
            if current:
                zones.append(current)
            current = {"name": stripped.split(":", 1)[1].strip()}
        elif stripped.startswith("Flags") and current:
            current["flags"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("ZoneType") and current:
            current["type"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("Version") and current:
            current["version"] = stripped.split(":", 1)[1].strip()
    if current:
        zones.append(current)
    for zone in zones:
        # AD-integrated zones accept secure dynamic updates; the flag string
        # is what samba-tool reports, so it is surfaced verbatim too.
        zone["dynamic_update"] = "DNS_RPC_ZONE_UPDATE_SECURE" in (zone.get("flags") or "")
    return zones


def create_zone(settings: Settings, zone: str) -> None:
    _run(settings, "zonecreate", server(settings), validate_zone(zone))


def reverse_zone_name(network: str) -> str:
    """The in-addr.arpa or ip6.arpa zone that answers for a network.

    Given 10.10.0.0/24 this is 0.10.10.in-addr.arpa: the octets the prefix
    covers, reversed. Only /8, /16 and /24 have a zone of their own; anything
    else needs classless delegation, which is not something to guess at.
    """
    address, _, prefix = network.strip().partition("/")
    try:
        network_object = ipaddress.ip_network(f"{address}/{prefix or '24'}", strict=False)
    except ValueError as exc:
        raise DnsError(f"{network!r} is not a network") from exc

    if network_object.version == 6:
        if network_object.prefixlen % 4:
            raise DnsError("an IPv6 reverse zone needs a prefix that is a multiple of 4")
        nibbles = network_object.network_address.exploded.replace(":", "")
        keep = network_object.prefixlen // 4
        return ".".join(reversed(nibbles[:keep])) + ".ip6.arpa"

    if network_object.prefixlen not in (8, 16, 24):
        raise DnsError("a reverse zone covers a /8, /16 or /24")
    octets = str(network_object.network_address).split(".")[: network_object.prefixlen // 8]
    return ".".join(reversed(octets)) + ".in-addr.arpa"


def pointer_for(address: str, zones: list[str]) -> tuple[str, str] | None:
    """Where the pointer record for this address belongs, if a zone holds it.

    Returns (zone, name-within-the-zone). None when no reverse zone covers the
    address, which is not an error: the forward record is still valid.
    """
    try:
        parsed = ipaddress.ip_address(address.strip())
    except ValueError:
        return None
    if parsed.version != 4:
        return None

    octets = str(parsed).split(".")
    for width in (24, 16, 8):
        zone = ".".join(reversed(octets[: width // 8])) + ".in-addr.arpa"
        if zone in zones:
            return zone, ".".join(reversed(octets[width // 8 :]))
    return None


def delete_zone(settings: Settings, zone: str) -> None:
    _run(settings, "zonedelete", server(settings), validate_zone(zone), "--force")


def zone_info(settings: Settings, zone: str) -> dict[str, Any]:
    output = _run(settings, "zoneinfo", server(settings), validate_zone(zone))
    info: dict[str, Any] = {"name": validate_zone(zone)}
    for line in output.splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            info[key.strip()] = value.strip()
    return info


# ----------------------------------------------------------------- records ---


def list_records(settings: Settings, zone: str) -> list[Record]:
    zone = validate_zone(zone)
    output = _run(settings, "query", server(settings), zone, "@", "ALL")
    records: list[Record] = []
    name = "@"
    for line in output.splitlines():
        node = _NODE_RE.match(line)
        if node:
            raw = node.group("name")
            name = raw if raw else "@"
            continue
        match = _RECORD_RE.match(line)
        if match:
            records.append(
                Record(
                    name=name,
                    type=match.group("type"),
                    data=match.group("data"),
                    ttl=int(match.group("ttl")),
                    serial=int(match.group("serial")),
                    flags=match.group("flags"),
                )
            )
    return records


def add_record(settings: Settings, zone: str, name: str, record_type: str, data: str) -> None:
    zone = validate_zone(zone)
    record_type = validate_type(record_type)
    _run(
        settings,
        "add",
        server(settings),
        zone,
        validate_name(name),
        record_type,
        validate_data(record_type, data),
    )


def delete_record(settings: Settings, zone: str, name: str, record_type: str, data: str) -> None:
    zone = validate_zone(zone)
    record_type = validate_type(record_type)
    _run(
        settings,
        "delete",
        server(settings),
        zone,
        validate_name(name),
        record_type,
        validate_data(record_type, data),
    )


def update_record(
    settings: Settings, zone: str, name: str, record_type: str, old: str, new: str
) -> None:
    zone = validate_zone(zone)
    record_type = validate_type(record_type)
    _run(
        settings,
        "update",
        server(settings),
        zone,
        validate_name(name),
        record_type,
        validate_data(record_type, old),
        validate_data(record_type, new),
    )
