"""A second factor answered on a phone."""

from __future__ import annotations

import conftest  # noqa: F401  (environment setup ordering)
import pytest

from odm import push
from odm.config import get_settings


def settings_with_ntfy():
    settings = get_settings().model_copy()
    settings.ntfy_url = "https://127.0.0.1:8444"
    settings.ntfy_public_url = "https://odm.corp.example.internal:8444"
    settings.ntfy_token = "tk_test"
    return settings


def test_a_topic_is_one_ntfy_accepts_and_nobody_guesses():
    seen = {push.new_topic() for _ in range(50)}
    assert len(seen) == 50
    for topic in seen:
        assert push.TOPIC_RE.match(topic), topic
        assert topic.startswith(push.TOPIC_PREFIX)
        # 18 random bytes, base64: at least 24 characters of entropy.
        assert len(topic) >= len(push.TOPIC_PREFIX) + 24


def test_the_phone_subscribes_to_the_public_name_not_the_loopback():
    """The phone must reach the server under the name on the certificate."""
    settings = settings_with_ntfy()
    url = push.subscribe_url(settings, "odm-abc")
    assert url == "https://odm.corp.example.internal:8444/odm-abc"


def test_the_buttons_carry_the_token_and_clear_the_notification():
    settings = settings_with_ntfy()
    header = push.actions_header(settings, "tok123")
    approve, deny = header.split("; ")
    assert approve.startswith("http, Approve, ")
    assert deny.startswith("http, Deny, ")
    assert f"{settings.console_url}/api/v1/push/tok123/approve" in approve
    assert f"{settings.console_url}/api/v1/push/tok123/deny" in deny
    # A stale "Approve?" left on the phone is one that gets tapped later.
    assert "clear=true" in approve and "clear=true" in deny
    assert "method=POST" in approve


def test_the_message_says_where_and_how_so_a_stranger_gets_denied():
    title, body = push.sign_in_message("ada", "ws-01.corp.example.internal", "ssh")
    assert "ada" in title
    assert "ws-01.corp.example.internal" in body
    assert "SSH" in body
    assert "deny" in body.lower()


def test_unconfigured_is_reported_not_attempted():
    settings = get_settings().model_copy()
    settings.ntfy_url = None
    assert not push.configured(settings)
    with pytest.raises(push.PushUnavailable):
        push.publish(settings, "odm-abc", "t", "m")


def test_a_bad_topic_is_refused_before_anything_is_sent():
    settings = settings_with_ntfy()
    with pytest.raises(push.PushError):
        push.publish(settings, "not a topic!", "t", "m")


def test_the_policy_carries_the_method_and_defaults_to_the_code():
    from odm.policy_schema import SecondFactor

    assert SecondFactor().method == "code"
    assert SecondFactor(method="push").method == "push"
    with pytest.raises(ValueError):
        SecondFactor(method="carrier-pigeon")
