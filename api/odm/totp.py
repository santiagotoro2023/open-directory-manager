"""A second factor for signing in to the console.

RFC 6238 time-based codes, computed with the standard library's HMAC — no
custom crypto (CLAUDE.md §6). The secret lives in ODM's own store rather than
the directory: it protects this console, and putting it in the directory would
hand it to anything that can read a user object.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

# The values every authenticator assumes when a URI does not say otherwise.
DIGITS = 6
PERIOD = 30
# One step either side, so a phone whose clock is slightly off still works.
DRIFT_STEPS = 1

RECOVERY_CODES = 10


class TotpError(Exception):
    """The code or the enrolment is not one ODM will accept."""


def generate_secret() -> str:
    """A base32 secret, as authenticator apps expect it."""
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def generate_recovery_codes(count: int = RECOVERY_CODES) -> list[str]:
    """Single-use codes for getting back in without the device.

    Without these, a lost phone is a locked-out administrator and somebody has
    to go and edit the database.
    """
    return [
        f"{secrets.token_hex(2)}-{secrets.token_hex(2)}-{secrets.token_hex(2)}"
        for _ in range(count)
    ]


def provisioning_uri(secret: str, principal: str, issuer: str) -> str:
    """The otpauth:// URI an authenticator scans.

    A QR code is only ever a rendering of this string, so the console can draw
    one without any of it being a secret ODM invented.
    """
    label = quote(f"{issuer}:{principal}", safe="")
    return (
        f"otpauth://totp/{label}?secret={secret}"
        f"&issuer={quote(issuer, safe='')}&algorithm=SHA1&digits={DIGITS}&period={PERIOD}"
    )


def _code_for(secret: str, step: int) -> str:
    padding = "=" * (-len(secret) % 8)
    try:
        key = base64.b32decode(secret + padding, casefold=True)
    except Exception as exc:  # noqa: BLE001 - any decode failure is the same answer
        raise TotpError("the enrolled secret is not valid base32") from exc
    digest = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    truncated = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(truncated % (10**DIGITS)).zfill(DIGITS)


def verify(
    secret: str, code: str, *, last_step: int | None = None, now: float | None = None
) -> int:
    """Check a code and return the step it matched.

    The step is returned so the caller can store it: a code stays valid for
    thirty seconds, and without remembering the last one accepted, anybody who
    saw it could use it again inside that window.
    """
    code = (code or "").strip().replace(" ", "")
    if not code.isdigit() or len(code) != DIGITS:
        raise TotpError("a code is six digits")

    current = int((now if now is not None else time.time()) // PERIOD)
    for offset in range(-DRIFT_STEPS, DRIFT_STEPS + 1):
        step = current + offset
        if last_step is not None and step <= last_step:
            continue
        # compare_digest, not ==: a timing difference would leak the code.
        if hmac.compare_digest(_code_for(secret, step), code):
            return step
    raise TotpError("that code is not right, or has already been used")


def matches_recovery(codes: list[str], candidate: str) -> str | None:
    """The recovery code this matches, if any. Constant time across the list."""
    candidate = (candidate or "").strip().lower()
    found = None
    for code in codes:
        if hmac.compare_digest(code, candidate):
            found = code
    return found
