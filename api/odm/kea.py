"""ISC Kea control (CLAUDE.md §3.8, §5.4).

Kea's Control Agent is the only thing ODM talks to for DHCP; its
configuration file is never hand-edited once ODM is managing it. Every
change is written through config-set and then persisted with config-write,
after config-test has proven Kea will accept it.
"""

from __future__ import annotations

import copy
import ipaddress
import re
from typing import Any

import httpx

from .config import Settings

NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")
TIMEOUT = httpx.Timeout(20.0)


class KeaError(Exception):
    """Kea refused the command, or is unreachable."""


class KeaUnavailable(KeaError):
    """The DHCP role is not configured on this deployment."""


def configured(settings: Settings) -> bool:
    return bool(settings.kea_url)


def _client(settings: Settings) -> httpx.Client:
    if not settings.kea_url:
        raise KeaUnavailable("no DHCP role configured (ODM_KEA_URL is unset)")
    auth = (
        (settings.kea_user, settings.kea_password)
        if settings.kea_user and settings.kea_password
        else None
    )
    verify: Any = str(settings.kea_ca_cert) if settings.kea_ca_cert else True
    return httpx.Client(timeout=TIMEOUT, auth=auth, verify=verify)


def command(
    settings: Settings, name: str, arguments: dict | None = None, service: str = "dhcp4"
) -> Any:
    """Send one Kea control command. Blocking."""
    payload: dict[str, Any] = {"command": name}
    if service:
        payload["service"] = [service]
    if arguments is not None:
        payload["arguments"] = arguments

    try:
        with _client(settings) as client:
            response = client.post(str(settings.kea_url), json=payload)
    except httpx.HTTPError as exc:
        raise KeaError(f"cannot reach the Kea control agent: {exc}") from exc

    if response.status_code != 200:
        raise KeaError(f"Kea returned {response.status_code}")
    try:
        body = response.json()
    except ValueError as exc:
        raise KeaError("Kea returned a malformed response") from exc

    entry = body[0] if isinstance(body, list) and body else body
    result = entry.get("result", 1)
    if result == 3:  # command succeeded but found nothing
        return entry.get("arguments", {})
    if result != 0:
        raise KeaError(entry.get("text", "Kea rejected the command"))
    return entry.get("arguments", {})


# ------------------------------------------------------------ configuration ---


def get_config(settings: Settings) -> dict[str, Any]:
    config = command(settings, "config-get")
    if "Dhcp4" not in config:
        raise KeaError("Kea returned no Dhcp4 configuration")
    return config


def apply_config(settings: Settings, config: dict[str, Any]) -> None:
    """Test, then set, then persist — in that order, always."""
    payload = {"Dhcp4": config["Dhcp4"]}
    command(settings, "config-test", payload)
    command(settings, "config-set", payload)
    command(settings, "config-write")


def subnets(settings: Settings) -> list[dict[str, Any]]:
    return list(get_config(settings)["Dhcp4"].get("subnet4", []))


def _find(config: dict[str, Any], subnet_id: int) -> dict[str, Any]:
    for subnet in config["Dhcp4"].get("subnet4", []):
        if int(subnet.get("id", 0)) == subnet_id:
            return subnet
    raise KeaError(f"no DHCP scope with id {subnet_id}")


def validate_scope(scope: dict[str, Any]) -> dict[str, Any]:
    """Shape and range-check a scope before it can reach Kea."""
    try:
        network = ipaddress.ip_network(str(scope["subnet"]), strict=False)
    except (KeyError, ValueError) as exc:
        raise KeaError("subnet must be CIDR, e.g. 10.10.0.0/24") from exc

    pools = []
    for pool in scope.get("pools", []):
        raw = str(pool.get("pool", "")).replace(" ", "")
        start, _, end = raw.partition("-")
        try:
            first, last = ipaddress.ip_address(start), ipaddress.ip_address(end)
        except ValueError as exc:
            raise KeaError(f"invalid pool {raw!r}; expected first-last") from exc
        if first not in network or last not in network:
            raise KeaError(f"pool {raw} is outside {network}")
        if first > last:
            raise KeaError(f"pool {raw} runs backwards")
        pools.append({"pool": f"{first} - {last}"})

    options = []
    for option in scope.get("option-data", []):
        name = str(option.get("name", ""))
        if not NAME_RE.match(name):
            raise KeaError(f"invalid option name {name!r}")
        options.append({"name": name, "data": str(option.get("data", ""))[:512]})

    validated: dict[str, Any] = {"subnet": str(network), "pools": pools, "option-data": options}
    if scope.get("id"):
        validated["id"] = int(scope["id"])
    for key in ("valid-lifetime", "renew-timer", "rebind-timer"):
        if scope.get(key) is not None:
            validated[key] = int(scope[key])
    if scope.get("comment"):
        validated["user-context"] = {"comment": str(scope["comment"])[:256]}
    return validated


def create_scope(settings: Settings, scope: dict[str, Any]) -> dict[str, Any]:
    config = copy.deepcopy(get_config(settings))
    existing = config["Dhcp4"].setdefault("subnet4", [])
    validated = validate_scope(scope)
    validated["id"] = validated.get("id") or (
        max((int(s.get("id", 0)) for s in existing), default=0) + 1
    )
    if any(s.get("subnet") == validated["subnet"] for s in existing):
        raise KeaError(f"a scope for {validated['subnet']} already exists")
    existing.append(validated)
    apply_config(settings, config)
    return validated


def update_scope(settings: Settings, subnet_id: int, scope: dict[str, Any]) -> dict[str, Any]:
    config = copy.deepcopy(get_config(settings))
    current = _find(config, subnet_id)
    validated = validate_scope({**scope, "id": subnet_id})
    # Reservations live on the subnet and are edited through their own calls.
    validated["reservations"] = current.get("reservations", [])
    config["Dhcp4"]["subnet4"] = [
        validated if int(s.get("id", 0)) == subnet_id else s
        for s in config["Dhcp4"]["subnet4"]
    ]
    apply_config(settings, config)
    return validated


def delete_scope(settings: Settings, subnet_id: int) -> dict[str, Any]:
    config = copy.deepcopy(get_config(settings))
    removed = _find(config, subnet_id)
    config["Dhcp4"]["subnet4"] = [
        s for s in config["Dhcp4"]["subnet4"] if int(s.get("id", 0)) != subnet_id
    ]
    apply_config(settings, config)
    return removed


# ----------------------------------------------------------- reservations ---


def validate_reservation(reservation: dict[str, Any]) -> dict[str, Any]:
    mac = str(reservation.get("hw-address", "")).strip().lower()
    if not MAC_RE.match(mac):
        raise KeaError("hardware address must look like 00:11:22:33:44:55")
    try:
        address = ipaddress.ip_address(str(reservation["ip-address"]))
    except (KeyError, ValueError) as exc:
        raise KeaError("reservation needs a valid IP address") from exc

    validated: dict[str, Any] = {"hw-address": mac, "ip-address": str(address)}
    hostname = str(reservation.get("hostname", "")).strip()
    if hostname:
        if not NAME_RE.match(hostname):
            raise KeaError(f"invalid hostname {hostname!r}")
        validated["hostname"] = hostname
    return validated


def add_reservation(
    settings: Settings, subnet_id: int, reservation: dict[str, Any]
) -> dict[str, Any]:
    config = copy.deepcopy(get_config(settings))
    subnet = _find(config, subnet_id)
    validated = validate_reservation(reservation)
    existing = subnet.setdefault("reservations", [])
    if any(r.get("hw-address") == validated["hw-address"] for r in existing):
        raise KeaError(f"{validated['hw-address']} is already reserved in this scope")
    if ipaddress.ip_address(validated["ip-address"]) not in ipaddress.ip_network(
        subnet["subnet"], strict=False
    ):
        raise KeaError(f"{validated['ip-address']} is outside {subnet['subnet']}")
    existing.append(validated)
    apply_config(settings, config)
    return validated


def delete_reservation(settings: Settings, subnet_id: int, hw_address: str) -> None:
    config = copy.deepcopy(get_config(settings))
    subnet = _find(config, subnet_id)
    mac = hw_address.strip().lower()
    remaining = [r for r in subnet.get("reservations", []) if r.get("hw-address") != mac]
    if len(remaining) == len(subnet.get("reservations", [])):
        raise KeaError(f"{mac} is not reserved in this scope")
    subnet["reservations"] = remaining
    apply_config(settings, config)


# ------------------------------------------------------------ leases, HA ---


def leases(settings: Settings) -> list[dict[str, Any]]:
    """Every current lease.

    Sent with no arguments, which is what asks for all of them. Passing
    {"subnets": []} looks like the same request and is not: Kea reads it as
    "the leases in these zero subnets" and answers with none, so the console
    showed an empty lease list under a scope reporting an address in use.
    """
    result = command(settings, "lease4-get-all")
    return list(result.get("leases", []))


def ha_status(settings: Settings) -> dict[str, Any]:
    """Failover state of the pair (CLAUDE.md §5.4)."""
    try:
        return command(settings, "status-get", service="dhcp4").get("high-availability", [])
    except KeaError as exc:
        return {"error": str(exc)}


def statistics(settings: Settings) -> dict[str, Any]:
    """Pool utilisation, for the scope list and the health dashboard."""
    raw = command(settings, "statistic-get-all", {})
    wanted = ("total-addresses", "assigned-addresses", "declined-addresses")
    out: dict[str, Any] = {}
    for key, samples in raw.items():
        if not samples or not isinstance(samples, list):
            continue
        if any(key.endswith(name) for name in wanted):
            out[key] = samples[0][0]
    return out
