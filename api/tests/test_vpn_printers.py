"""Tunnels and printers: addressing, key material, and what is refused."""

from __future__ import annotations

import base64

import conftest  # noqa: F401  (environment setup ordering)
import pytest

from odm import printers, vpn

# ---------------------------------------------------------------------- vpn --


def test_a_generated_keypair_is_a_wireguard_keypair():
    private, public = vpn.keypair()

    # WireGuard keys are 32 raw bytes, base64 — 44 characters ending in '='.
    for key in (private, public):
        assert len(base64.b64decode(key)) == 32
    assert private != public


def test_every_keypair_is_different():
    assert vpn.keypair()[0] != vpn.keypair()[0]


def test_the_server_takes_the_first_address_and_peers_come_after():
    assert vpn.server_address("10.99.0.0/24") == "10.99.0.1/24"
    assert vpn.next_peer_address("10.99.0.0/24", []) == "10.99.0.2/32"


def test_a_peer_never_reuses_an_address():
    taken = ["10.99.0.2/32", "10.99.0.3/32"]
    assert vpn.next_peer_address("10.99.0.0/24", taken) == "10.99.0.4/32"


def test_a_full_tunnel_says_so_rather_than_wrapping_round():
    # /30 is the server, one peer, and the broadcast address.
    taken = [vpn.next_peer_address("10.99.0.0/30", [])]
    with pytest.raises(vpn.VpnError):
        vpn.next_peer_address("10.99.0.0/30", taken)


def test_a_tunnel_network_too_small_to_hold_a_peer_is_refused():
    with pytest.raises(vpn.VpnError):
        vpn.validate_network("10.99.0.0/31")


@pytest.mark.parametrize(
    "name", ["", "a" * 40, "tun 0", "tun/0", "$(id)", "-leading"]
)
def test_a_tunnel_name_that_is_not_an_interface_name_is_refused(name):
    """The name becomes a network interface and a systemd unit instance."""
    with pytest.raises(vpn.VpnError):
        vpn.validate_name(name)


def test_a_client_configuration_carries_what_a_peer_needs_and_nothing_else():
    private, public = vpn.keypair()
    peer_private, peer_public = vpn.keypair()
    tunnel = {
        "name": "homeoffice",
        "endpoint": "vpn.example.internal",
        "listen_port": 51820,
        "network": "10.99.0.0/24",
        "routes": ["10.10.0.0/24"],
        "dns_servers": ["10.10.0.10"],
        "search_domain": "corp.example.internal",
        "private_key": private,
        "public_key": public,
    }
    peer = {"name": "ada-laptop", "address": "10.99.0.2/32", "private_key": peer_private}

    body = vpn.client_config(tunnel, peer)

    assert "PrivateKey = " + peer_private in body
    assert "PublicKey = " + public in body
    assert "Endpoint = vpn.example.internal:51820" in body
    assert "AllowedIPs = 10.10.0.0/24" in body
    # The server's own private key must never appear in something handed out.
    assert private not in body
    assert peer_public not in body


def test_a_peer_whose_key_was_not_kept_cannot_be_exported():
    with pytest.raises(vpn.VpnError):
        vpn.client_config(
            {
                "name": "t",
                "endpoint": "vpn",
                "listen_port": 51820,
                "network": "10.99.0.0/24",
                "routes": [],
                "dns_servers": [],
                "search_domain": "",
                "public_key": "x",
            },
            {"name": "p", "address": "10.99.0.2/32", "private_key": None},
        )


def test_the_node_task_omits_disabled_peers():
    tunnel = {
        "name": "homeoffice",
        "network": "10.99.0.0/24",
        "listen_port": 51820,
        "private_key": "x",
    }
    task = vpn.as_task(
        tunnel,
        [
            {"name": "on", "public_key": "a", "address": "10.99.0.2/32", "enabled": True},
            {"name": "off", "public_key": "b", "address": "10.99.0.3/32", "enabled": False},
        ],
    )
    assert [peer["name"] for peer in task["peers"]] == ["on"]


# ----------------------------------------------------------------- printers --


@pytest.mark.parametrize(
    "uri",
    [
        "ipp://10.10.0.31/ipp/print",
        "ipps://printer.example.internal/ipp/print",
        "socket://10.10.0.31:9100",
        "usb://HP/LaserJet",
    ],
)
def test_real_device_addresses_are_accepted(uri):
    assert printers.validate_device_uri(uri) == uri


@pytest.mark.parametrize(
    "uri",
    ["", "file:///etc/shadow", "http://x/", "ipp://x; rm -rf /", "$(id)", "ipp://"],
)
def test_a_device_address_that_is_not_a_cups_uri_is_refused(uri):
    """The value reaches lpadmin on a print server running as root."""
    with pytest.raises(printers.PrinterError):
        printers.validate_device_uri(uri)


def test_a_ppd_is_recognised_and_anything_else_is_not():
    assert printers.validate_ppd('*PPD-Adobe: "4.3"\n*ModelName: "X"\n')
    assert printers.validate_ppd(None) is None
    assert printers.validate_ppd("") is None
    with pytest.raises(printers.PrinterError):
        printers.validate_ppd("this is not a PPD at all")


@pytest.mark.parametrize("name", ["", "with space", "a/b", "a#b", "-leading", "a" * 80])
def test_a_printer_name_cups_would_refuse_is_refused_here(name):
    with pytest.raises(printers.PrinterError):
        printers.validate_name(name)
