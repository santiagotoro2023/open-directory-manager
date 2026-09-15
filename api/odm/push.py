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

import json
import re
import secrets
from datetime import UTC, datetime, timedelta
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
    now = now or datetime.now(UTC)
    return now + timedelta(seconds=settings.push_timeout_seconds)


def server_url(settings: Settings, override: str = "") -> str:
    """Where phones reach the server: a policy's own external address when it
    names one (a port forwarded through a router), else the controller's."""
    return (override or settings.ntfy_public_url or settings.ntfy_url or "").rstrip("/")


def subscribe_url(settings: Settings, topic: str, override: str = "") -> str:
    """What the person types into the ntfy app: the server, then the topic."""
    return f"{server_url(settings, override)}/{topic}"



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
    if not configured(settings) or not settings.ntfy_url:
        raise PushUnavailable("phone approvals are not set up (ODM_NTFY_URL is unset)")
    if not TOPIC_RE.match(topic):
        raise PushError("not a valid topic name")
    headers = {"Title": title, "Priority": priority, "Tags": "lock"}
    if actions:
        headers["Actions"] = actions
    url = f"{settings.ntfy_url.rstrip('/')}/{topic}"
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
    settings: Settings,
    topic: str,
    token: str,
    principal: str,
    hostname: str,
    service: str,
    override: str = "",
) -> None:
    title, body = sign_in_message(principal, hostname, service)
    publish(settings, topic, title, body, actions=actions_header(settings, token, override))


def ask_to_confirm_phone(
    settings: Settings, topic: str, token: str, principal: str, override: str = ""
) -> None:
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
        actions=_action("Confirm", answer_url(settings, token, override), "approved"),
        priority="default",
    )


# ------------------------------------------------------------- answers ----
# A phone answers by publishing one word to a topic named after the token —
# through the same server it subscribes to, so the one forwarded port is
# enough for approvals from anywhere, and the console itself is never
# exposed. The server's access rules make those topics write-only for
# everyone and readable by the control plane's account alone, so nobody can
# see how a sign-in was answered, and nobody can answer one without the
# token, which was only ever sent to the one phone.

ANSWER_PREFIX = "odm-answer-"


def answer_topic(token: str) -> str:
    return ANSWER_PREFIX + token


def answer_url(settings: Settings, token: str, override: str = "") -> str:
    """Where a button on the phone sends its answer: the answer topic, on the
    server the phone already reaches."""
    return f"{server_url(settings, override)}/{answer_topic(token)}"


def _action(label: str, url: str, body: str) -> str:
    # ntfy's action syntax: type, label, url, then options. clear=true takes
    # the notification off the phone once it has been answered, so a stale
    # "Approve?" is not left lying around to be tapped later.
    return f"http, {label}, {url}, method=POST, body={body}, clear=true"


def actions_header(settings: Settings, token: str, override: str = "") -> str:
    """The two buttons, in ntfy's header format."""
    url = answer_url(settings, token, override)
    return "; ".join([_action("Approve", url, "approved"), _action("Deny", url, "denied")])


def read_answer(settings: Settings, token: str) -> str | None:
    """The phone's answer to one token, if it has given one: "approved",
    "denied", or None. Read from the server's cache over the loopback,
    with the control plane's own account. Blocking."""
    if not configured(settings) or not settings.ntfy_url:
        raise PushUnavailable("phone approvals are not set up (ODM_NTFY_URL is unset)")
    url = f"{settings.ntfy_url.rstrip('/')}/{answer_topic(token)}/json"
    try:
        with _client(settings) as client:
            response = client.get(url, params={"poll": "1", "since": "all"})
    except httpx.HTTPError as exc:
        raise PushError(f"could not reach the notification server: {exc}") from exc
    if response.status_code >= 400:
        raise PushError(f"the notification server refused the read: {response.status_code}")
    for line in response.text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("event") != "message":
            continue
        word = str(event.get("message", "")).strip().lower()
        if word in ("approved", "denied"):
            return word
    return None


async def settle_enrolment(
    conn: Any, settings: Settings, principal_sid: str, source_ip: str | None
) -> bool:
    """Finish an enrolment whose phone has tapped Confirm, and say whether it
    is finished. Called wherever somebody is waiting to know."""
    from fastapi.concurrency import run_in_threadpool

    from . import audit

    row = await conn.fetchrow(
        "SELECT principal, confirm_token, confirmed_at FROM push_enrolment "
        "WHERE principal_sid = $1",
        principal_sid,
    )
    if row is None:
        return False
    if row["confirmed_at"]:
        return True
    if not row["confirm_token"]:
        return False
    try:
        answer = await run_in_threadpool(read_answer, settings, row["confirm_token"])
    except PushError:
        return False
    if answer != "approved":
        return False
    await conn.execute(
        "UPDATE push_enrolment SET confirmed_at = now(), confirm_token = NULL, "
        "updated_at = now() WHERE principal_sid = $1",
        principal_sid,
    )
    await audit.record(
        conn,
        actor=row["principal"],
        actor_sid=principal_sid,
        source_ip=source_ip,
        action="auth.second_factor.push.enrol",
        outcome="success",
        object_type="session",
        detail="a phone was confirmed for sign-in approvals",
    )
    return True


async def settle_challenge(conn: Any, settings: Settings, challenge_id: str) -> str:
    """The answer so far to one sign-in: pending, approved, denied or
    expired — reading the phone's answer off the server if it has not been
    recorded yet, and recording it."""
    from fastapi.concurrency import run_in_threadpool

    from . import audit

    row = await conn.fetchrow(
        """
        SELECT token, decision, expires_at, principal, principal_sid, machine_dn, hostname,
               service
        FROM push_challenge WHERE id = $1::uuid
        """,
        challenge_id,
    )
    if row is None:
        return "missing"
    if row["decision"]:
        return str(row["decision"])
    if row["expires_at"] < datetime.now(row["expires_at"].tzinfo):
        return "expired"
    try:
        answer = await run_in_threadpool(read_answer, settings, row["token"])
    except PushError:
        return "pending"
    if answer is None:
        return "pending"
    await conn.execute(
        "UPDATE push_challenge SET decision = $2, decided_at = now() "
        "WHERE id = $1::uuid AND decision IS NULL",
        challenge_id,
        answer,
    )
    await audit.record(
        conn,
        actor=row["principal"],
        actor_sid=row["principal_sid"],
        source_ip=None,
        action=f"auth.second_factor.push.{answer}",
        outcome="success" if answer == "approved" else "denied",
        object_type="session",
        object_dn=row["machine_dn"],
        detail=f"{row['service']} sign-in at {row['hostname']} {answer} from the phone",
    )
    return answer
