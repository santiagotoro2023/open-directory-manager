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
    """What a QR code carries: an ntfy:// link, which the ntfy app opens as
    its own subscribe dialog for this server and topic. A plain https link
    opened the server's web page instead, and that page had the same
    Confirm button the phone gets — a tap there enrolled a phone that was
    never subscribed. The web page is disabled on the server as well."""
    base = server_url(settings, override)
    scheme = "ntfyhttp" if base.startswith("http://") else "ntfy"
    return f"{scheme}://{base.split('://', 1)[-1]}/{topic}"



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


# ------------------------------------------------------------ retiring ----
# The policy is the source of truth for whether somebody has a second
# factor, and of which kind. An enrolment the policy no longer asks for is
# not kept around to be asked for later: a method taken out of the policy
# takes its enrolments with it, for the people the policy covered, and the
# walkthrough sets up whatever the policy asks for next time they sign in.


def _covered(wanted: Any) -> tuple[str, list[str] | None]:
    """How a policy's coverage selects rows: everyone, everyone but these
    names, or only these names. Static statements below, one per shape, so
    every statement here is one PostgreSQL can be shown whole."""
    if wanted is None:
        return "all", None
    names = sorted(str(name).lower() for name in set(wanted) if isinstance(name, str))
    if type(wanted).__name__ == "_AllExcept":
        return "except", names
    return "only", names


_DELETE = {
    ("code", "all"): "DELETE FROM totp_enrolment",
    ("code", "except"): (
        "DELETE FROM totp_enrolment "
        "WHERE lower(split_part(principal, '@', 1)) <> ALL($1::text[])"
    ),
    ("code", "only"): (
        "DELETE FROM totp_enrolment WHERE lower(split_part(principal, '@', 1)) = ANY($1::text[])"
    ),
    ("push", "all"): "DELETE FROM push_enrolment",
    ("push", "except"): (
        "DELETE FROM push_enrolment "
        "WHERE lower(split_part(principal, '@', 1)) <> ALL($1::text[])"
    ),
    ("push", "only"): (
        "DELETE FROM push_enrolment WHERE lower(split_part(principal, '@', 1)) = ANY($1::text[])"
    ),
    ("asked", "all"): "DELETE FROM push_challenge",
    ("asked", "except"): (
        "DELETE FROM push_challenge "
        "WHERE lower(split_part(principal, '@', 1)) <> ALL($1::text[])"
    ),
    ("asked", "only"): (
        "DELETE FROM push_challenge WHERE lower(split_part(principal, '@', 1)) = ANY($1::text[])"
    ),
}


async def _delete(conn: Any, what: str, shape: str, names: list[str] | None) -> int:
    statement = _DELETE[(what, shape)]
    status = await (conn.execute(statement) if names is None else conn.execute(statement, names))
    return int(status.split()[-1]) if status else 0


async def retire_enrolments(
    conn: Any,
    wanted: Any,
    methods: set[str],
    *,
    actor: str,
    actor_sid: str | None,
    source_ip: str | None,
    reason: str,
) -> dict[str, int]:
    """Delete the enrolments of the given methods for the accounts a policy
    covers, and say how many went. One audit entry for the lot."""
    from . import audit

    shape, names = _covered(wanted)
    removed: dict[str, int] = {}
    if "code" in methods:
        removed["code"] = await _delete(conn, "code", shape, names)
    if "push" in methods:
        removed["push"] = await _delete(conn, "push", shape, names)
        await _delete(conn, "asked", shape, names)
    if any(removed.values()):
        await audit.record(
            conn,
            actor=actor,
            actor_sid=actor_sid,
            source_ip=source_ip,
            action="auth.second_factor.retire",
            outcome="success",
            object_type="session",
            detail=f"{reason}: removed "
            + ", ".join(f"{count} {method}" for method, count in removed.items()),
        )
    return removed


def methods_no_longer_asked_for(old: dict | None, new: dict | None) -> set[str]:
    """Which methods a policy change stops asking for.

    Turned off or taken out: both. Switched from one method to the other:
    the one it left. Anything else: nothing — including turning it on, which
    only ever adds.
    """
    if not old or not old.get("enabled"):
        return set()
    if not new or not new.get("enabled"):
        return {"code", "push"}
    before, after = old.get("method") or "code", new.get("method") or "code"
    return {before} if before != after else set()


# ---------------------------------------------------------------- trust ----
# A phone checks the certificate it is shown against what it already trusts.
# A self-signed console certificate, or one from the domain's own authority,
# is trusted by nobody's phone until somebody installs it — and the ntfy app
# does not offer to trust it on the way in when a link opens it, so the
# walkthrough has to say so, first.

CONSOLE_CERTIFICATE = "/etc/odm/tls/api.crt"


def trust_state(settings: Settings) -> str:
    """What a phone has to do about the certificate: "self-signed" (install
    the console's own), "domain-ca" (install the domain's root), or
    "public" (nothing)."""
    from pathlib import Path

    from . import ca

    try:
        pem = Path(CONSOLE_CERTIFICATE).read_text(encoding="ascii")
    except OSError:
        return "self-signed"
    if ca.is_self_signed(pem):
        return "self-signed"
    if ca.initialised(settings):
        try:
            ours = ca.issued_here(settings, pem)
        except (OSError, ValueError, TypeError, ca.CaError):
            ours = False
        if ours:
            return "domain-ca"
    return "public"


def trust_url(settings: Settings) -> str:
    return f"{settings.console_url}/api/v1/ca/trust.crt"
