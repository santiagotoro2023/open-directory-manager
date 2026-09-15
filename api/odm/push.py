"""A second factor answered on a phone (CLAUDE.md §3.1, §6).

The phone runs the ntfy app, subscribed to a topic of its own on the ntfy
server setup.sh installs beside the control plane. A sign-in that needs
approving becomes one notification on that topic with two buttons, Approve
and Deny; each button is an HTTP request back to this control plane carrying
a token that identifies exactly that sign-in. The machine asking meanwhile
polls for the answer, and falls back to asking for a code when none comes.

Three properties carry the security of this, and all three are decided here
rather than on the phone or the machine:

- The topic is the only thing that lets a phone receive these. It is long,
  random, and shown to the person once, when they subscribe (like a TOTP
  secret) — and ntfy is configured so that anyone may *read* a topic they
  know the name of but only this control plane may publish, so nobody can
  put a fake "Approve?" in front of a person to fish for a tap.
- The token in the buttons is unguessable, single-use, tied to one sign-in
  on one machine, and expires in a minute. Tapping Approve on an old
  notification does nothing.
- Everything between phone and server is TLS, with the same certificate the
  console uses. Plain HTTP would put the Approve link in front of anyone on
  the network, and a link is all approval takes.

Only the control plane reads or writes any of it. The machine learns one
thing: approved, or not.
"""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from .config import Settings

# ntfy's own rule for a topic name. token_urlsafe only produces characters
# inside it, so a generated topic is always valid.
TOPIC_RE = re.compile(r"^[-_A-Za-z0-9]{1,64}$")
TOPIC_PREFIX = "odm-"
TIMEOUT = httpx.Timeout(10.0)


class PushError(Exception):
    """ntfy refused the message, or is unreachable."""


class PushUnavailable(PushError):
    """Phone approvals are not set up on this deployment."""


def configured(settings: Settings) -> bool:
    return bool(settings.ntfy_url and settings.ntfy_token)


def new_topic() -> str:
    """A topic nobody could guess. 18 bytes is 144 bits, which is plenty."""
    return TOPIC_PREFIX + secrets.token_urlsafe(18)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def expiry(settings: Settings, now: datetime | None = None) -> datetime:
    now = now or datetime.now(timezone.utc)
    return now + timedelta(seconds=settings.push_timeout_seconds)


def subscribe_url(settings: Settings, topic: str) -> str:
    """What the person types into the ntfy app: the server, then the topic."""
    base = (settings.ntfy_public_url or settings.ntfy_url or "").rstrip("/")
    return f"{base}/{topic}"


def answer_url(settings: Settings, token: str, decision: str) -> str:
    """Where a button on the phone sends its answer."""
    return f"{settings.console_url}/api/v1/push/{token}/{decision}"


def _action(label: str, url: str) -> str:
    # ntfy's action syntax: type, label, url, then options. clear=true takes
    # the notification off the phone once it has been answered, so a stale
    # "Approve?" is not left lying around to be tapped later.
    return f"http, {label}, {url}, method=POST, clear=true"


def actions_header(settings: Settings, token: str) -> str:
    """The two buttons, in ntfy's header format."""
    return "; ".join(
        [
            _action("Approve", answer_url(settings, token, "approve")),
            _action("Deny", answer_url(settings, token, "deny")),
        ]
    )


def sign_in_message(principal: str, hostname: str, service: str) -> tuple[str, str]:
    """Title and body of the notification, as a person reads them at a glance.

    What it is for and where it is from, so somebody who did not just sign in
    anywhere knows to tap Deny.
    """
    where = {
        "login": "at the desk",
        "ssh": "over SSH",
        "sudo": "for administrator rights",
        "remote-desktop": "by remote desktop",
    }.get(service, service)
    return (
        f"Sign in as {principal}?",
        f"Someone is signing in to {hostname} {where}. If this is not you, deny it.",
    )


def _client(settings: Settings) -> httpx.Client:
    if not configured(settings):
        raise PushUnavailable("phone approvals are not set up (ODM_NTFY_URL is unset)")
    verify: Any = str(settings.ntfy_ca_cert) if settings.ntfy_ca_cert else True
    headers = {"Authorization": f"Bearer {settings.ntfy_token}"}
    return httpx.Client(timeout=TIMEOUT, headers=headers, verify=verify)


def publish(
    settings: Settings,
    topic: str,
    title: str,
    message: str,
    *,
    actions: str = "",
    priority: str = "high",
) -> None:
    """Send one notification to one phone. Blocking."""
    if not TOPIC_RE.match(topic):
        raise PushError("not a valid topic name")
    headers = {"Title": title, "Priority": priority, "Tags": "lock"}
    if actions:
        headers["Actions"] = actions
    url = f"{settings.ntfy_url.rstrip('/')}/{topic}"  # type: ignore[union-attr]
    try:
        with _client(settings) as client:
            response = client.post(url, content=message.encode(), headers=headers)
    except httpx.HTTPError as exc:
        raise PushError(f"could not reach the notification server: {exc}") from exc
    if response.status_code >= 400:
        raise PushError(
            f"the notification server refused the message: {response.status_code} "
            f"{response.text[:200]}"
        )


def ask_to_sign_in(
    settings: Settings, topic: str, token: str, principal: str, hostname: str, service: str
) -> None:
    title, body = sign_in_message(principal, hostname, service)
    publish(settings, topic, title, body, actions=actions_header(settings, token))


def ask_to_confirm_phone(settings: Settings, topic: str, token: str, principal: str) -> None:
    """The enrolment's own proof of possession: a button on the phone.

    Tapping it is what finishes enrolling — the same reason a TOTP enrolment
    is not finished until a code from the device is accepted.
    """
    publish(
        settings,
        topic,
        f"Confirm this phone for {principal}",
        "Tap Confirm to finish setting up sign-in approvals for your account. "
        "If you did not just do this, ignore it.",
        actions=_action("Confirm", answer_url(settings, token, "approve")),
        priority="default",
    )
