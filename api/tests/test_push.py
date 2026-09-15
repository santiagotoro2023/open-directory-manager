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
    assert url == "ntfy://odm.corp.example.internal:8444/odm-abc"


def test_the_buttons_answer_through_the_server_the_phone_already_reaches():
    """Only the notification server is ever exposed; the console is not. The
    answer is one word published to a topic named after the token."""
    settings = settings_with_ntfy()
    header = push.actions_header(settings, "tok123")
    approve, deny = header.split("; ")
    assert approve.startswith("http, Approve, ")
    assert deny.startswith("http, Deny, ")
    url = "https://odm.corp.example.internal:8444/odm-answer-tok123"
    assert f", {url}, " in approve and f", {url}, " in deny
    assert "body=approved" in approve and "body=denied" in deny
    assert settings.console_url not in header
    # A stale "Approve?" left on the phone is one that gets tapped later.
    assert "clear=true" in approve and "clear=true" in deny
    assert "method=POST" in approve


def test_a_policy_can_point_phones_somewhere_else():
    """A port forwarded through a router: the buttons and the subscription
    both use the address the policy names, not the controller's."""
    settings = settings_with_ntfy()
    outside = "https://odm.example.org:8444"
    assert push.subscribe_url(settings, "odm-abc", outside) == "ntfy://odm.example.org:8444/odm-abc"
    assert f"{outside}/odm-answer-tok" in push.actions_header(settings, "tok", outside)


def test_an_answer_topic_is_one_ntfy_accepts():
    topic = push.answer_topic(push.new_token())
    assert push.TOPIC_RE.match(topic), topic
    assert len(topic) <= 64


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


def test_the_external_address_must_be_https_or_nothing():
    from odm.policy_schema import SecondFactor

    assert SecondFactor(push_server_url="").push_server_url == ""
    assert SecondFactor(push_server_url=" https://odm.example.org:8444/ ").push_server_url == (
        "https://odm.example.org:8444"
    )
    with pytest.raises(ValueError):
        SecondFactor(push_server_url="http://odm.example.org:8444")
