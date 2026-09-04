#!/usr/bin/env python3
"""Make this domain the one in an export taken from another.

Run by setup.sh --import, and usable on its own afterwards. It signs in to the
console the way an operator does and posts the file to the import endpoint, so
the control plane does the work — nothing here writes to the directory or to
ODM's own store.

    ODM_IMPORT_URL=https://dc1.example.org:8443 \\
    ODM_IMPORT_REALM=example.org \\
    ODM_IMPORT_FILE=/root/odm-example.org.json \\
        python3 import-configuration.py < password

The password is read from standard input so it is never in a process list.
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

CA_CERT = "/etc/odm/tls/api.crt"


def fail(message: str) -> None:
    print(f"      {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    base = os.environ.get("ODM_IMPORT_URL", "").rstrip("/")
    realm = os.environ.get("ODM_IMPORT_REALM", "")
    path = os.environ.get("ODM_IMPORT_FILE", "")
    if not (base and realm and path):
        fail("ODM_IMPORT_URL, ODM_IMPORT_REALM and ODM_IMPORT_FILE must all be set")

    password = sys.stdin.read()
    if not password:
        fail("no password on standard input")

    # The console's certificate is on this machine while it is self-signed.
    # Verified against it rather than not verified at all: the password for
    # the domain administrator is about to go over this connection.
    context = ssl.create_default_context()
    if os.path.exists(CA_CERT):
        try:
            context.load_verify_locations(CA_CERT)
        except OSError:
            pass
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=context),
        urllib.request.HTTPCookieProcessor(jar),
    )

    def post(url: str, body: bytes, headers: dict[str, str]) -> dict:
        request = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json", **headers}
        )
        try:
            with opener.open(request, timeout=600) as answer:
                return json.loads(answer.read() or b"{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            fail(f"{url.rsplit('/', 1)[-1]}: {exc.code} {detail}")
        except OSError as exc:
            fail(f"{url}: {exc}")
        return {}

    session = post(
        f"{base}/api/v1/auth/login",
        json.dumps({"username": f"Administrator@{realm}", "password": password}).encode(),
        {},
    )
    csrf = session.get("csrf_token")
    if not csrf:
        fail("signed in but the console returned no CSRF token")

    with open(path, "rb") as handle:
        document = handle.read()

    answer = post(
        f"{base}/api/v1/domain/import?apply=true", document, {"X-ODM-CSRF": csrf}
    )
    if not answer.get("applied"):
        fail("the console did not apply the import")

    result = answer.get("result") or {}
    made = result.get("directory") or {}
    dns = result.get("dns") or {}
    if made:
        print("      " + ", ".join(
            f"{count} {name.replace('_', ' ')}" for name, count in made.items()
        ))
    print(f"      {dns.get('zones', 0)} DNS zone(s), {dns.get('records', 0)} record(s)")
    tables = result.get("tables") or {}
    if tables:
        print(f"      {sum(tables.values())} row(s) across {len(tables)} settings tables")
    problems = result.get("problems") or []
    for problem in problems[:10]:
        print(f"      ! {problem}")
    if len(problems) > 10:
        print(f"      ! and {len(problems) - 10} more; the audit log has all of them")


if __name__ == "__main__":
    main()
