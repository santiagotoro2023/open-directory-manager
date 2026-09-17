"""Bitwarden's client-side cryptography and the vault's REST API, as the
console needs them to run an organisation without anyone opening the
vault's own pages.

Bitwarden encrypts everything on the client; the server stores ciphertext
and never holds a key. So a console that manages an organisation — makes
it, invites people, confirms them, makes collections and hands groups
their access — has to be a client: derive keys the way the apps do, wrap
the organisation's key for each person with their public key, encrypt a
collection's name. This module is that client, the documented formats
and nothing more:

- master key: PBKDF2-SHA256 over the master password, salted with the
  e-mail address, 600 000 rounds; the server-side hash is one more round
  of PBKDF2 over the key with the password as salt.
- a symmetric key is 64 bytes, half for AES-256-CBC and half for
  HMAC-SHA256; an "EncString" of type 2 is `2.iv|ciphertext|mac`, all
  base64. The user's key is wrapped with the master key stretched by
  HKDF-Expand ("enc" and "mac").
- an RSA-2048 key pair per user and per organisation; a key handed to a
  person is the organisation's 64 bytes under RSA-OAEP-SHA1 with their
  public key, an EncString of type 4: `4.ciphertext`.

The HTTP side speaks to Vaultwarden's API with a bearer token. The token
comes from the console's own OpenID provider — the console signs its
service account in through the vault's SSO the way a browser would — so
no password ever has to reach the vault for that account either.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from dataclasses import dataclass
from typing import Any

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives import padding as sym_padding
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.hkdf import HKDFExpand
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

KDF_ITERATIONS = 600_000
CLIENT_HEADERS = {
    "Bitwarden-Client-Name": "web",
    "Bitwarden-Client-Version": "2025.8.0",
    "Device-Type": "9",
}
# Bitwarden's membership types and statuses.
TYPE_OWNER, TYPE_ADMIN, TYPE_USER = 0, 1, 2
STATUS_INVITED, STATUS_ACCEPTED, STATUS_CONFIRMED = 0, 1, 2


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def unb64(text: str) -> bytes:
    return base64.b64decode(text)


# --- keys ----------------------------------------------------------------


def master_key(password: str, email: str) -> bytes:
    kdf = PBKDF2HMAC(hashes.SHA256(), 32, email.strip().lower().encode(), KDF_ITERATIONS)
    return kdf.derive(password.encode())


def master_password_hash(key: bytes, password: str) -> str:
    """What the server is shown instead of the password: one more round,
    salted with the password itself."""
    return b64(PBKDF2HMAC(hashes.SHA256(), 32, password.encode(), 1).derive(key))


def stretch(key: bytes) -> bytes:
    enc = HKDFExpand(hashes.SHA256(), 32, b"enc").derive(key)
    mac = HKDFExpand(hashes.SHA256(), 32, b"mac").derive(key)
    return enc + mac


def new_symmetric_key() -> bytes:
    return secrets.token_bytes(64)


def encrypt(key64: bytes, plaintext: bytes) -> str:
    """An EncString of type 2 under a 64-byte symmetric key."""
    enc_key, mac_key = key64[:32], key64[32:]
    iv = os.urandom(16)
    padder = sym_padding.PKCS7(128).padder()
    padded = padder.update(plaintext) + padder.finalize()
    encryptor = Cipher(algorithms.AES(enc_key), modes.CBC(iv)).encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    mac = hmac.new(mac_key, iv + ciphertext, hashlib.sha256).digest()
    return f"2.{b64(iv)}|{b64(ciphertext)}|{b64(mac)}"


def decrypt(key64: bytes, enc_string: str) -> bytes:
    kind, _, rest = enc_string.partition(".")
    if kind != "2":
        raise ValueError(f"not a type-2 EncString: {kind!r}")
    iv_b64, ct_b64, mac_b64 = rest.split("|")
    iv, ciphertext, mac = unb64(iv_b64), unb64(ct_b64), unb64(mac_b64)
    expected = hmac.new(key64[32:], iv + ciphertext, hashlib.sha256).digest()
    if not hmac.compare_digest(mac, expected):
        raise ValueError("EncString MAC does not match")
    decryptor = Cipher(algorithms.AES(key64[:32]), modes.CBC(iv)).decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = sym_padding.PKCS7(128).unpadder()
    return unpadder.update(padded) + unpadder.finalize()


def encrypt_text(key64: bytes, text: str) -> str:
    return encrypt(key64, text.encode())


def decrypt_text(key64: bytes, enc_string: str) -> str:
    return decrypt(key64, enc_string).decode()


def new_rsa_pair() -> tuple[str, bytes]:
    """A user's or an organisation's key pair: the public key as base64
    SPKI (what the server keeps and hands out), the private key as PKCS8
    DER bytes (to be wrapped with the owner's symmetric key)."""
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_der = private.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    private_der = private.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return b64(public_der), private_der


def wrap_for(public_key_b64: str, key64: bytes) -> str:
    """The organisation's key for one person: RSA-OAEP-SHA1 under their
    public key, an EncString of type 4."""
    public = serialization.load_der_public_key(unb64(public_key_b64))
    assert isinstance(public, rsa.RSAPublicKey)
    ciphertext = public.encrypt(
        key64,
        padding.OAEP(mgf=padding.MGF1(hashes.SHA1()), algorithm=hashes.SHA1(), label=None),  # noqa: S303
    )
    return f"4.{b64(ciphertext)}"


def unwrap_with(private_der: bytes, enc_string: str) -> bytes:
    kind, _, rest = enc_string.partition(".")
    if kind != "4":
        raise ValueError(f"not a type-4 EncString: {kind!r}")
    private = serialization.load_der_private_key(private_der, password=None)
    assert isinstance(private, rsa.RSAPrivateKey)
    return private.decrypt(
        unb64(rest),
        padding.OAEP(mgf=padding.MGF1(hashes.SHA1()), algorithm=hashes.SHA1(), label=None),  # noqa: S303
    )


@dataclass
class NewAccountKeys:
    """Everything set-password needs for an account that has no master
    password yet, plus the user key itself for whoever keeps it."""

    master_password_hash: str
    protected_user_key: str
    public_key: str
    encrypted_private_key: str
    user_key: bytes


def account_keys(password: str, email: str) -> NewAccountKeys:
    key = master_key(password, email)
    user_key = new_symmetric_key()
    public, private_der = new_rsa_pair()
    return NewAccountKeys(
        master_password_hash=master_password_hash(key, password),
        protected_user_key=encrypt(stretch(key), user_key),
        public_key=public,
        encrypted_private_key=encrypt(user_key, private_der),
        user_key=user_key,
    )


def field(record: dict[str, Any], name: str, default: Any = None) -> Any:
    """A JSON field whatever its casing: Vaultwarden has answered in
    PascalCase and in camelCase across versions."""
    for key, value in record.items():
        if key.lower() == name.lower():
            return value
    return default


# --- the vault's API -------------------------------------------------------


class VaultError(Exception):
    pass


class VaultClient:
    """Vaultwarden's API from one signed-in account. `base` is the vault
    (…/vault), `token` a bearer token for it."""

    def __init__(self, http: httpx.Client, base: str, token: str = "") -> None:
        self.http = http
        self.base = base.rstrip("/")
        self.token = token

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {**CLIENT_HEADERS, "Accept": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if extra:
            headers.update(extra)
        return headers

    def call(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        form: dict[str, str] | None = None,
        extra: dict[str, str] | None = None,
    ) -> Any:
        response = self.http.request(
            method,
            self.base + path,
            headers=self._headers(extra),
            json=body if form is None else None,
            data=form,
        )
        if response.status_code >= 400:
            try:
                detail = response.json()
                message = (
                    (field(detail, "errorModel", {}) or {}).get("message")
                    if isinstance(detail, dict)
                    else None
                )
                message = (
                    message
                    or field(detail, "message", "")
                    or field(detail, "error_description", "")
                )
            except ValueError:
                message = response.text[:200]
            raise VaultError(f"{method} {path}: {response.status_code} {message}")
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            return response.text

    # accounts
    def set_password(self, keys: NewAccountKeys, hint: str = "") -> None:
        self.call(
            "POST",
            "/api/accounts/set-password",
            {
                "kdf": 0,
                "kdfIterations": KDF_ITERATIONS,
                "kdfMemory": None,
                "kdfParallelism": None,
                "key": keys.protected_user_key,
                "keys": {
                    "publicKey": keys.public_key,
                    "encryptedPrivateKey": keys.encrypted_private_key,
                },
                "masterPasswordHash": keys.master_password_hash,
                "masterPasswordHint": hint or None,
                "orgIdentifier": None,
            },
        )

    def profile(self) -> dict[str, Any]:
        return self.call("GET", "/api/accounts/profile")

    def public_key_of(self, user_id: str) -> str:
        answer = self.call("GET", f"/api/users/{user_id}/public-key")
        return str(field(answer, "publicKey", ""))

    # organisations
    def create_organization(
        self,
        name: str,
        billing_email: str,
        owner_public_key: str,
        first_collection: str,
    ) -> tuple[str, bytes]:
        """Make the organisation as the signed-in account, who becomes its
        owner. Returns its id and its key."""
        org_key = new_symmetric_key()
        public, private_der = new_rsa_pair()
        answer = self.call(
            "POST",
            "/api/organizations",
            {
                "name": name,
                "billingEmail": billing_email,
                "collectionName": encrypt_text(org_key, first_collection),
                "key": wrap_for(owner_public_key, org_key),
                "keys": {"publicKey": public, "encryptedPrivateKey": encrypt(org_key, private_der)},
                "planType": 0,
            },
        )
        return str(field(answer, "id")), org_key

    def members(self, org_id: str) -> list[dict[str, Any]]:
        answer = self.call("GET", f"/api/organizations/{org_id}/users")
        return list(field(answer, "data", []) or [])

    def invite(self, org_id: str, emails: list[str], member_type: int = TYPE_USER) -> None:
        if not emails:
            return
        self.call(
            "POST",
            f"/api/organizations/{org_id}/users/invite",
            {
                "emails": emails,
                "type": member_type,
                "accessAll": False,
                "collections": [],
                "groups": [],
                "permissions": {},
            },
        )

    def confirm(self, org_id: str, member_id: str, wrapped_org_key: str) -> None:
        self.call(
            "POST",
            f"/api/organizations/{org_id}/users/{member_id}/confirm",
            {"key": wrapped_org_key},
        )

    def remove_member(self, org_id: str, member_id: str) -> None:
        self.call("DELETE", f"/api/organizations/{org_id}/users/{member_id}")

    def groups(self, org_id: str) -> list[dict[str, Any]]:
        answer = self.call("GET", f"/api/organizations/{org_id}/groups")
        return list(field(answer, "data", []) or [])

    def group_users(self, org_id: str, group_id: str) -> list[str]:
        answer = self.call("GET", f"/api/organizations/{org_id}/groups/{group_id}/users")
        return [str(entry) for entry in (answer or [])]

    def save_group(
        self,
        org_id: str,
        group_id: str | None,
        name: str,
        external_id: str,
        member_ids: list[str],
        collections: list[dict[str, Any]],
    ) -> str:
        body = {
            "name": name,
            "accessAll": False,
            "externalId": external_id,
            "collections": collections,
            "users": member_ids,
        }
        if group_id:
            answer = self.call("PUT", f"/api/organizations/{org_id}/groups/{group_id}", body)
        else:
            answer = self.call("POST", f"/api/organizations/{org_id}/groups", body)
        return str(field(answer, "id", group_id or ""))

    def delete_group(self, org_id: str, group_id: str) -> None:
        self.call("DELETE", f"/api/organizations/{org_id}/groups/{group_id}")

    def collections(self, org_id: str) -> list[dict[str, Any]]:
        answer = self.call("GET", f"/api/organizations/{org_id}/collections")
        return list(field(answer, "data", []) or [])

    def save_collection(
        self,
        org_id: str,
        collection_id: str | None,
        encrypted_name: str,
        external_id: str,
        groups: list[dict[str, Any]],
    ) -> str:
        body = {"name": encrypted_name, "externalId": external_id, "groups": groups, "users": []}
        if collection_id:
            answer = self.call(
                "PUT", f"/api/organizations/{org_id}/collections/{collection_id}", body
            )
        else:
            answer = self.call("POST", f"/api/organizations/{org_id}/collections", body)
        return str(field(answer, "id", collection_id or ""))

    def delete_collection(self, org_id: str, collection_id: str) -> None:
        self.call("DELETE", f"/api/organizations/{org_id}/collections/{collection_id}")


def access_entry(group_id: str, read_only: bool) -> dict[str, Any]:
    """One line of a collection's (or a group's) access list."""
    return {"id": group_id, "readOnly": read_only, "hidePasswords": False, "manage": False}


def parse_json(text: str) -> Any:
    return json.loads(text)
