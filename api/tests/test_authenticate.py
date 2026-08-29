"""directory.authenticate — the bind itself.

Every other test fakes this function wholesale, so the code that decides
*which name* to bind with had no coverage at all. A sign-in that says
"invalid credentials" for a correct password is what that gap cost.
"""

from __future__ import annotations

import conftest  # noqa: F401  (environment setup ordering)
import pytest

from odm import directory
from odm.config import get_settings


@pytest.fixture
def wired(monkeypatch):
    """Records the name each bind is attempted with."""
    attempts: list[str] = []
    fake = conftest.FakeLdap(conftest.sample_directory())

    monkeypatch.setattr(directory, "service_connection", lambda settings, read_only=True: fake)

    def connect(settings, user, password):
        attempts.append(user)
        if password != "correct-horse":
            raise directory.InvalidCredentials("invalidCredentials")
        return fake

    monkeypatch.setattr(directory, "_connect", connect)
    return attempts


def test_a_bare_name_binds_as_the_distinguished_name(wired):
    """Not as user@REALM: an account without a userPrincipalName cannot be
    matched that way, and Samba refuses the bind as a bad password."""
    user = directory.authenticate(get_settings(), "ada", "correct-horse")

    assert wired == [conftest.ADMIN.dn]
    assert user.sam_account_name == "ada"


def test_a_upn_also_binds_as_the_distinguished_name(wired):
    directory.authenticate(get_settings(), "ada@corp.example.internal", "correct-horse")
    assert wired == [conftest.ADMIN.dn]


def test_one_bind_attempt_per_sign_in(wired):
    """Trying several name forms would multiply the account's failure count
    in the directory on every mistyped password."""
    with pytest.raises(directory.InvalidCredentials):
        directory.authenticate(get_settings(), "ada", "wrong")

    assert len(wired) == 1, f"bound {len(wired)} times: {wired}"


def test_an_unknown_account_never_reaches_a_bind(wired):
    with pytest.raises((directory.NotAuthorized, directory.InvalidCredentials)):
        directory.authenticate(get_settings(), "nobody", "correct-horse")

    assert wired == [], "bound with an unresolved name"


def test_an_empty_password_never_reaches_a_bind(wired):
    """An empty password makes an LDAP unauthenticated bind, which succeeds."""
    with pytest.raises(directory.InvalidCredentials):
        directory.authenticate(get_settings(), "ada", "")

    assert wired == []


def test_the_service_bind_names_the_account_not_the_service_principal(monkeypatch):
    """The keytab also holds HTTP/<host>, which is what the library would pick
    on its own. Active Directory issues a ticket-granting ticket to an account,
    never to one of its service principal names, so binding under the SPN is
    refused as an unknown client."""
    captured: dict[str, object] = {}

    class Recorder:
        def __init__(self, server, **kwargs):
            captured.update(kwargs)

        def bind(self):
            return True

    monkeypatch.setattr(directory, "_tls", lambda settings: None)
    monkeypatch.setattr(directory, "Server", lambda *a, **k: object())
    monkeypatch.setattr(directory, "Connection", Recorder)

    settings = get_settings()
    directory.service_connection(settings)

    assert captured["user"] == f"{settings.service_account}@{settings.realm}"
    assert "HTTP/" not in str(captured["user"])
