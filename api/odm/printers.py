"""Printers, and what the print server has to be told to make one real.

A printer is defined once on a print server and handed to people by policy.
The PPD — the Linux equivalent of a print driver — is optional: anything made
in the last decade speaks IPP Everywhere and CUPS configures it itself. Where
one is uploaded it is stored here, so a server rebuilt from scratch gets its
printers back without anyone hunting for driver files again.
"""

from __future__ import annotations

import re
from typing import Any

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
# CUPS device URIs. Deliberately narrow: this value reaches lpadmin.
_URI_RE = re.compile(r"^(ipp|ipps|socket|lpd|usb|smb|dnssd)://[A-Za-z0-9._~:/?#%@!$&'()*+,;=-]{1,240}$")


class PrinterError(Exception):
    """The printer definition is not one ODM will accept."""


def validate_name(name: str) -> str:
    name = (name or "").strip()
    # CUPS forbids spaces, slashes and hashes in a queue name; the pattern is
    # narrower still because the name becomes part of a URI clients resolve.
    if not _NAME_RE.match(name):
        raise PrinterError(f"invalid printer name {name!r}")
    return name


def validate_device_uri(uri: str) -> str:
    uri = (uri or "").strip()
    if not _URI_RE.match(uri):
        raise PrinterError(
            "the device address must be a CUPS URI, for example "
            "ipp://10.10.0.31/ipp/print or socket://10.10.0.31:9100"
        )
    return uri


def validate_ppd(ppd: str | None) -> str | None:
    """Check that an uploaded file is actually a PPD.

    Refused at the boundary rather than discovered by lpadmin on the node: a
    printer that fails to apply for a reason the operator cannot see is worse
    than an upload that says no.
    """
    if not ppd:
        return None
    if "*PPD-Adobe" not in ppd[:512]:
        raise PrinterError("that file is not a PPD: no *PPD-Adobe line at the top")
    if len(ppd) > 4_000_000:
        raise PrinterError("that PPD is larger than 4 MB")
    return ppd


def as_task(row: dict[str, Any]) -> dict[str, Any]:
    """What the print server needs to make this printer real."""
    return {
        "name": validate_name(row["name"]),
        "device_uri": validate_device_uri(row["device_uri"]),
        "description": str(row.get("description") or "")[:255],
        "location": str(row.get("location") or "")[:255],
        "ppd": row.get("ppd") or "",
        "ppd_name": str(row.get("ppd_name") or "")[:128],
        "duplex": bool(row.get("duplex", False)),
        "colour": bool(row.get("colour", True)),
        "shared": bool(row.get("shared", True)),
    }
