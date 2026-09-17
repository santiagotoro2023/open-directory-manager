"""Bitwarden's formats, as the console produces them: what a client of
ours would decrypt with the same inputs."""

from __future__ import annotations

import base64

from odm import bitwarden


def test_a_symmetric_encstring_round_trips_and_its_mac_is_checked():
    key = bitwarden.new_symmetric_key()
    text = bitwarden.encrypt_text(key, "Sales")
    assert text.startswith("2.") and text.count("|") == 2
    assert bitwarden.decrypt_text(key, text) == "Sales"
    # A different key (or a tampered MAC) is refused, not decrypted to noise.
    other = bitwarden.new_symmetric_key()
    try:
        bitwarden.decrypt_text(other, text)
    except ValueError as exc:
        assert "MAC" in str(exc)
    else:
        raise AssertionError("decrypted with the wrong key")


def test_the_master_key_follows_bitwardens_derivation():
    # 600 000 rounds of PBKDF2-SHA256 salted with the lower-cased address,
    # and the server hash is one round more salted with the password.
    key = bitwarden.master_key("correct horse", "Ada@Corp.Example")
    assert len(key) == 32
    assert bitwarden.master_key("correct horse", "ada@corp.example") == key
    assert bitwarden.master_password_hash(key, "correct horse") != bitwarden.b64(key)
    stretched = bitwarden.stretch(key)
    assert len(stretched) == 64 and stretched[:32] != stretched[32:]


def test_account_keys_wrap_the_user_key_so_the_password_unlocks_it():
    keys = bitwarden.account_keys("correct horse", "ada@corp.example")
    master = bitwarden.master_key("correct horse", "ada@corp.example")
    assert bitwarden.decrypt(bitwarden.stretch(master), keys.protected_user_key) == keys.user_key
    private_der = bitwarden.decrypt(keys.user_key, keys.encrypted_private_key)
    # The organisation key handed to this person comes back with that private key.
    org_key = bitwarden.new_symmetric_key()
    wrapped = bitwarden.wrap_for(keys.public_key, org_key)
    assert wrapped.startswith("4.")
    assert bitwarden.unwrap_with(private_der, wrapped) == org_key
    base64.b64decode(keys.public_key)  # SPKI, base64


def test_fields_are_found_whatever_their_casing():
    assert bitwarden.field({"UserId": 1}, "userId") == 1
    assert bitwarden.field({"userId": 2}, "UserId") == 2
    assert bitwarden.field({}, "x", "d") == "d"
