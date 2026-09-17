"""The console runs the vault's organisation.

Everything about the password manager is decided in the console — who has
a seat, which collections exist, which groups see which — and this module
makes the vault agree, on a timer and whenever somebody presses Apply:

- The console's own service account (a domain user, `odm-vault`) owns the
  organisation. It signs in through the vault's single sign-on like anyone
  else — the console is the OpenID provider, so it can sign its own
  account in without a password — sets itself a master password nobody
  is ever told, and makes the organisation, named after the domain. The
  organisation's key is kept here, because confirming a member and naming
  a collection are things only a holder of that key can do; personal
  vaults stay as unreadable to the console as to the server.
- Seats: the members of the chosen domain groups (and any accounts named
  directly) are invited; someone who has accepted is confirmed; someone
  no longer entitled is removed. A person's own first sign-in makes their
  account and sets their master password, as Bitwarden's own flow does.
- Groups: each domain group involved becomes a group of the organisation
  with the same members.
- Collections: each collection the console lists exists in the vault under
  that name, and the groups the console gives it are the groups that see
  it, read-only where the console says so.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import secrets
import uuid
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit

import asyncpg
import httpx
from fastapi.concurrency import run_in_threadpool
from ldap3.utils.conv import escape_filter_chars

from . import bitwarden, ca, directory, objects, oidc, vaultproxy
from .config import Settings
from .routes_directory import _bound

log = logging.getLogger(__name__)

OWNER_ACCOUNT = "odm-vault"
FIRST_COLLECTION = "Shared"
RECONCILE_SECONDS = 300
# The device the console's sessions with the vault are known by.
DEVICE_ID = "8f7c1d2e-0d1a-4b8e-9c6a-0d3000000001"


class KeeperError(Exception):
    pass


# --- reaching the vault -----------------------------------------------------


def _http(settings: Settings) -> httpx.Client:
    return httpx.Client(
        verify=str(ca.cert_path(settings)), timeout=httpx.Timeout(60.0, connect=10.0)
    )


def _vault_base(node: str) -> str:
    return f"https://{node}:{vaultproxy.VAULT_PORT}{vaultproxy.PREFIX}"


async def sign_in(
    pool: asyncpg.Pool,
    settings: Settings,
    http: httpx.Client,
    node: str,
    user: directory.DirectoryUser,
) -> tuple[bitwarden.VaultClient, dict[str, Any]]:
    """Sign a domain account into the vault through its single sign-on,
    the way a browser would — except that the console is the OpenID
    provider and issues its own code for the account rather than asking
    anyone for a password. Returns a client and the token response."""
    base = _vault_base(node)
    public = vaultproxy.vault_url(settings)
    client = bitwarden.VaultClient(http, base)

    def start() -> dict[str, str]:
        answer = client.call("GET", "/identity/sso/prevalidate?domainHint=odm")
        sso_token = str(bitwarden.field(answer, "token", ""))
        verifier = secrets.token_urlsafe(48)
        challenge = oidc._b64(hashlib.sha256(verifier.encode()).digest())
        query = urlencode(
            {
                "client_id": "web",
                "redirect_uri": public + "/sso-connector.html",
                "response_type": "code",
                "scope": "api offline_access",
                "state": "odm",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "domain_hint": "odm",
                "ssoToken": sso_token,
            }
        )
        response = http.get(
            f"{base}/identity/connect/authorize?{query}",
            headers=bitwarden.CLIENT_HEADERS,
            follow_redirects=False,
        )
        if response.status_code not in (302, 303, 307) or "location" not in response.headers:
            raise KeeperError(
                f"the vault did not start single sign-on: {response.status_code} "
                f"{response.text[:200]}"
            )
        params = dict(parse_qsl(urlsplit(response.headers["location"]).query))
        params["_verifier"] = verifier
        return params

    params = await run_in_threadpool(start)
    verifier = params.pop("_verifier")
    client_row = await oidc._client(pool, params.get("client_id", ""))
    if client_row is None:
        raise KeeperError("the vault is not registered with the console's OpenID provider")
    request = oidc.AuthRequest(params, client_row)
    async with pool.acquire() as conn:
        code = await oidc._issue_code(conn, settings, request, user)

    def finish() -> dict[str, Any]:
        response = http.get(
            f"{base}/identity/connect/oidc-signin?"
            + urlencode({"code": code, "state": params.get("state", "")}),
            headers=bitwarden.CLIENT_HEADERS,
            follow_redirects=False,
        )
        if response.status_code not in (302, 303, 307) or "location" not in response.headers:
            raise KeeperError(
                f"the vault refused the console's sign-in: {response.status_code} "
                f"{response.text[:200]}"
            )
        back = dict(parse_qsl(urlsplit(response.headers["location"]).query))
        if "code" not in back:
            raise KeeperError("the vault sent no code back: " + response.headers["location"][:200])
        token = client.call(
            "POST",
            "/identity/connect/token",
            form={
                "grant_type": "authorization_code",
                "client_id": "web",
                "code": back["code"],
                "code_verifier": verifier,
                "redirect_uri": public + "/sso-connector.html",
                "scope": "api offline_access",
                "deviceType": "9",
                "deviceIdentifier": DEVICE_ID,
                "deviceName": "Open Directory Manager",
            },
        )
        return token

    token = await run_in_threadpool(finish)
    client.token = str(bitwarden.field(token, "access_token", ""))
    if not client.token:
        raise KeeperError("the vault issued no token")
    return client, token


def has_master_password(token: dict[str, Any]) -> bool:
    options = bitwarden.field(token, "UserDecryptionOptions", {}) or {}
    return bool(bitwarden.field(options, "HasMasterPassword", False))


# --- the directory side -----------------------------------------------------


def address_of(settings: Settings, attrs: dict[str, Any]) -> str:
    sam = str(attrs.get("sAMAccountName") or "")
    mail = str(attrs.get("mail") or "") or f"{sam}@{settings.domain}"
    return mail.lower()


def members_of_groups(
    conn: Any, settings: Settings, groups: list[str], users: list[str]
) -> tuple[dict[str, dict[str, Any]], dict[str, set[str]]]:
    """Everyone entitled to a seat, by address, and each group's members
    by address — enabled accounts only, nesting included. Blocking."""
    people: dict[str, dict[str, Any]] = {}
    per_group: dict[str, set[str]] = {}
    for group in groups:
        found = objects.find_group(conn, settings, group)
        dn = escape_filter_chars(str(found["distinguishedName"]))
        entries = objects._search(
            conn,
            settings.base_dn,
            f"(&(objectCategory=person)(objectClass=user)(memberOf:1.2.840.113556.1.4.1941:={dn}))",
            ["sAMAccountName", "mail", "displayName", "userAccountControl"],
        )
        per_group[group] = set()
        for entry in entries:
            attrs = entry["attributes"]
            if int(attrs.get("userAccountControl") or 0) & 2:
                continue
            address = address_of(settings, attrs)
            people[address] = {"name": str(attrs.get("displayName") or attrs.get("sAMAccountName"))}
            per_group[group].add(address)
    for user in users:
        try:
            found = objects.find_user(conn, settings, user.lstrip("%"))
        except objects.NotFound:
            continue
        if int(found.get("userAccountControl") or 0) & 2:
            continue
        address = address_of(settings, found)
        people[address] = {"name": str(found.get("displayName") or found.get("sAMAccountName"))}
    return people, per_group


async def ensure_owner_account(
    conn: asyncpg.Connection, settings: Settings, row: asyncpg.Record
) -> str:
    """The console's own domain account for the vault, made once."""
    if row["owner_account"]:
        return row["owner_account"]
    async with _bound(settings, write=True) as ldap:
        try:
            await run_in_threadpool(
                objects.create_user,
                ldap,
                settings,
                {
                    "sam_account_name": OWNER_ACCOUNT,
                    "name": "ODM password manager",
                    "container": f"CN=Users,{settings.base_dn}",
                    "description": (
                        "Owns the password manager's organisation for the console. Made by ODM."
                    ),
                    "mail": f"{OWNER_ACCOUNT}@{settings.domain}",
                    "password": secrets.token_urlsafe(24),
                },
            )
        except objects.ObjectError as exc:
            if "exist" not in str(exc).lower():
                raise
    account = f"{OWNER_ACCOUNT}@{settings.domain}"
    await conn.execute(
        "UPDATE password_manager SET owner_account = $1, updated_at = now() WHERE id = 1", account
    )
    return account


# --- bootstrap and reconcile ------------------------------------------------


async def _admin_invite(http: httpx.Client, node: str, admin_token: str, email: str) -> None:
    """Vaultwarden's admin page can invite an address that nobody in the
    organisation could yet: the first one, the console's own."""
    base = _vault_base(node)

    def go() -> None:
        response = http.post(
            f"{base}/admin",
            data={"token": admin_token},
            follow_redirects=False,
            headers={"Accept": "text/html"},
        )
        if response.status_code >= 400:
            raise KeeperError(f"the vault's admin page refused the token: {response.status_code}")
        response = http.post(
            f"{base}/admin/invite",
            json={"email": email},
            cookies=response.cookies,
            follow_redirects=False,
        )
        if response.status_code >= 400 and "already exists" not in response.text.lower():
            raise KeeperError(
                f"could not invite {email}: {response.status_code} {response.text[:200]}"
            )

    await run_in_threadpool(go)


async def bootstrap(pool: asyncpg.Pool, settings: Settings, http: httpx.Client, node: str) -> None:
    """The organisation, made once: the console's account invited by the
    vault's admin page, signed in, given a master password, and made the
    owner of an organisation named after the domain."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM password_manager WHERE id = 1")
        if row["org_id"]:
            return
        if not row["admin_token"]:
            raise KeeperError("waiting for the vault's admin token from the server (press Apply)")
        owner = await ensure_owner_account(conn, settings, row)
        await _admin_invite(http, node, row["admin_token"], owner)
        user = await run_in_threadpool(directory.authorize_principal, settings, owner)
        client, token = await sign_in(pool, settings, http, node, user)
        password = row["owner_password"] or secrets.token_urlsafe(32)
        if not has_master_password(token):
            keys = bitwarden.account_keys(password, owner)
            await run_in_threadpool(client.set_password, keys, "")
            public_key = keys.public_key
        else:
            if not row["owner_password"]:
                raise KeeperError(
                    "the console's vault account has a master password the console does not know"
                )
            profile = await run_in_threadpool(client.profile)
            public_key = await run_in_threadpool(
                client.public_key_of, str(bitwarden.field(profile, "id"))
            )
        org_name = settings.domain
        org_id, org_key = await run_in_threadpool(
            client.create_organization, org_name, owner, public_key, FIRST_COLLECTION
        )
        await conn.execute(
            """
            UPDATE password_manager
            SET owner_password = $1, org_id = $2, org_key = $3, org_name = $4, updated_at = now()
            WHERE id = 1
            """,
            password,
            org_id,
            bitwarden.b64(org_key),
            org_name,
        )
        # The vault's first collection is the console's first collection too.
        vault_collections = await run_in_threadpool(client.collections, org_id)
        first = next(
            (
                c
                for c in vault_collections
                if bitwarden.decrypt_text(org_key, str(bitwarden.field(c, "name")))
                == FIRST_COLLECTION
            ),
            None,
        )
        await conn.execute(
            """
            INSERT INTO vault_collection (name, vault_id, created_by)
            VALUES ($1, $2, 'console') ON CONFLICT (name) DO UPDATE SET vault_id = EXCLUDED.vault_id
            """,
            FIRST_COLLECTION,
            str(bitwarden.field(first, "id", "")) if first else "",
        )
        log.info("password manager: organisation %s made in the vault", org_name)


async def reconcile(pool: asyncpg.Pool, settings: Settings) -> str:
    """One pass: the vault made to match the console. Returns a summary."""
    node = await vaultproxy.node(pool)
    if not node:
        return "the role is not installed"
    if not ca.initialised(settings):
        return "no certificate authority yet"
    with _http(settings) as http:
        await bootstrap(pool, settings, http, node)
        row = await pool.fetchrow("SELECT * FROM password_manager WHERE id = 1")
        org_id = row["org_id"]
        org_key = bitwarden.unb64(row["org_key"])
        seat_groups = _json_list(row["sync_groups"])
        seat_users = _json_list(row["seat_users"])
        access_rows = await pool.fetch(
            "SELECT c.id, c.name, c.vault_id, a.group_name, a.read_only"
            " FROM vault_collection c LEFT JOIN vault_collection_access a ON a.collection_id = c.id"
            " ORDER BY c.name"
        )
        access_groups = sorted({r["group_name"] for r in access_rows if r["group_name"]})
        all_groups = sorted(set(seat_groups) | set(access_groups))

        async with _bound(settings, write=False) as ldap:
            people, per_group = await run_in_threadpool(
                members_of_groups, ldap, settings, all_groups, seat_users
            )
        # Only the seat groups (and named accounts) give a seat; an access
        # group whose member has no seat sees nothing until they get one.
        entitled = {a for g in seat_groups for a in per_group.get(g, set())}
        for user in seat_users:
            for address in people:
                if address.split("@")[0] == user.lstrip("%").lower():
                    entitled.add(address)
        owner = row["owner_account"].lower()

        user = await run_in_threadpool(
            directory.authorize_principal, settings, row["owner_account"]
        )
        client, _token = await sign_in(pool, settings, http, node, user)

        # --- seats
        members = await run_in_threadpool(client.members, org_id)
        by_address = {str(bitwarden.field(m, "email", "")).lower(): m for m in members}
        invited, confirmed, removed = [], [], []
        missing = sorted(a for a in entitled if a not in by_address and a != owner)
        if missing:
            await run_in_threadpool(client.invite, org_id, missing)
            invited = missing
        for address, member in by_address.items():
            if (
                address == owner
                or int(bitwarden.field(member, "type", 2) or 2) == bitwarden.TYPE_OWNER
            ):
                continue
            member_id = str(bitwarden.field(member, "id"))
            status = int(bitwarden.field(member, "status", 0) or 0)
            if address not in entitled:
                await run_in_threadpool(client.remove_member, org_id, member_id)
                removed.append(address)
                continue
            if status == bitwarden.STATUS_ACCEPTED:
                public = await run_in_threadpool(
                    client.public_key_of, str(bitwarden.field(member, "userId"))
                )
                if public:
                    await run_in_threadpool(
                        client.confirm, org_id, member_id, bitwarden.wrap_for(public, org_key)
                    )
                    confirmed.append(address)
        members = await run_in_threadpool(client.members, org_id)
        by_address = {str(bitwarden.field(m, "email", "")).lower(): m for m in members}

        # --- collections, first without access, so the groups can name them
        existing = await run_in_threadpool(client.collections, org_id)
        by_external = {str(bitwarden.field(c, "externalId", "") or ""): c for c in existing}
        by_vault_id = {str(bitwarden.field(c, "id")): c for c in existing}
        wanted_collections: dict[str, dict[str, Any]] = {}
        for r in access_rows:
            cid = str(r["id"])
            entry = wanted_collections.setdefault(
                cid, {"name": r["name"], "vault_id": r["vault_id"], "access": {}}
            )
            if r["group_name"]:
                entry["access"][r["group_name"]] = bool(r["read_only"])
        for cid, entry in wanted_collections.items():
            current = by_vault_id.get(entry["vault_id"]) or by_external.get(cid)
            if current is None:
                vault_id = await run_in_threadpool(
                    client.save_collection,
                    org_id,
                    None,
                    bitwarden.encrypt_text(org_key, entry["name"]),
                    cid,
                    [],
                )
                entry["vault_id"] = vault_id
                await pool.execute(
                    "UPDATE vault_collection SET vault_id = $2 WHERE id = $1::uuid", cid, vault_id
                )
            else:
                vault_id = str(bitwarden.field(current, "id"))
                if vault_id != entry["vault_id"]:
                    entry["vault_id"] = vault_id
                    await pool.execute(
                        "UPDATE vault_collection SET vault_id = $2 WHERE id = $1::uuid",
                        cid,
                        vault_id,
                    )
        # Anything in the vault that the console once made and no longer lists.
        for external_id, collection in by_external.items():
            if external_id and _is_uuid(external_id) and external_id not in wanted_collections:
                await run_in_threadpool(
                    client.delete_collection, org_id, str(bitwarden.field(collection, "id"))
                )

        # --- groups: one per domain group involved, with its members
        vault_groups = await run_in_threadpool(client.groups, org_id)
        group_by_name = {str(bitwarden.field(g, "name", "")).lower(): g for g in vault_groups}
        group_ids: dict[str, str] = {}
        for group in all_groups:
            addresses = per_group.get(group, set())
            member_ids = [
                str(bitwarden.field(by_address[a], "id"))
                for a in sorted(addresses)
                if a in by_address
            ]
            collections = [
                bitwarden.access_entry(e["vault_id"], e["access"][group])
                for e in wanted_collections.values()
                if group in e["access"] and e["vault_id"]
            ]
            current = group_by_name.get(group.lower())
            group_ids[group] = await run_in_threadpool(
                client.save_group,
                org_id,
                str(bitwarden.field(current, "id")) if current else None,
                group,
                "odm:" + group,
                member_ids,
                collections,
            )
        for name, group in group_by_name.items():
            external = str(bitwarden.field(group, "externalId", "") or "")
            if external.startswith("odm:") and name not in {g.lower() for g in all_groups}:
                await run_in_threadpool(
                    client.delete_group, org_id, str(bitwarden.field(group, "id"))
                )

        # --- collections again, now naming their groups
        for cid, entry in wanted_collections.items():
            groups = [
                bitwarden.access_entry(group_ids[g], ro)
                for g, ro in entry["access"].items()
                if g in group_ids
            ]
            await run_in_threadpool(
                client.save_collection,
                org_id,
                entry["vault_id"],
                bitwarden.encrypt_text(org_key, entry["name"]),
                cid,
                groups,
            )

        report = [
            {
                "email": address,
                "name": people.get(address, {}).get("name", ""),
                "status": ["invited", "accepted", "confirmed"][
                    min(int(bitwarden.field(m, "status", 0) or 0), 2)
                ]
                if int(bitwarden.field(m, "status", 0) or 0) >= 0
                else "revoked",
            }
            for address, m in sorted(by_address.items())
            if address != owner
        ]
        summary = (
            f"{len(report)} seat(s): {len(invited)} invited, {len(confirmed)} confirmed, "
            f"{len(removed)} removed; {len(wanted_collections)} collection(s), "
            f"{len(all_groups)} group(s)"
        )
        await pool.execute(
            """
            UPDATE password_manager
            SET members = $1::jsonb, last_sync_at = now(), last_sync_result = $2,
                sync_requested = false, updated_at = now()
            WHERE id = 1
            """,
            json.dumps(report),
            summary,
        )
        return summary


async def set_master_password(
    pool: asyncpg.Pool, settings: Settings, account: str, password: str
) -> None:
    """Give one person's vault account a master password — theirs to type,
    never kept here — the way their first sign-in would. Only for an
    account that has none yet; an existing one is left alone."""
    node = await vaultproxy.node(pool)
    if not node:
        raise KeeperError("the role is not installed")
    user = await run_in_threadpool(directory.authorize_principal, settings, account)
    email = oidc.claims_for(settings, user)["email"]
    with _http(settings) as http:
        client, token = await sign_in(pool, settings, http, node, user)
        if has_master_password(token):
            raise KeeperError("that vault account already has a master password")
        keys = bitwarden.account_keys(password, email)
        await run_in_threadpool(client.set_password, keys, "")
    await pool.execute("UPDATE password_manager SET sync_requested = true WHERE id = 1")


def _json_list(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return [str(x) for x in raw]
    try:
        return [str(x) for x in json.loads(raw or "[]")]
    except (TypeError, ValueError):
        return []


def _is_uuid(text: str) -> bool:
    try:
        uuid.UUID(text)
        return True
    except ValueError:
        return False


async def reconcile_loop(pool: asyncpg.Pool, settings: Settings) -> None:
    """Every five minutes, and within seconds of a request. Runs with the app."""
    with contextlib.suppress(asyncio.CancelledError):
        waited = 0
        while True:
            await asyncio.sleep(5)
            waited += 5
            try:
                requested = await pool.fetchval(
                    "SELECT sync_requested FROM password_manager WHERE id = 1"
                )
                if not requested and waited < RECONCILE_SECONDS:
                    continue
                waited = 0
                if not await vaultproxy.node(pool):
                    continue
                summary = await reconcile(pool, settings)
                log.info("password manager: %s", summary)
            except Exception as exc:  # noqa: BLE001 - the loop must outlive one bad pass
                log.warning("password manager pass failed: %s", exc)
                with contextlib.suppress(Exception):
                    await pool.execute(
                        "UPDATE password_manager SET last_sync_result = $1, sync_requested = false,"
                        " last_sync_at = now() WHERE id = 1",
                        f"failed: {exc}"[:500],
                    )


def now() -> datetime:
    return datetime.now(UTC)
