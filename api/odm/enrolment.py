"""Machine enrolment (CLAUDE.md §5.6).

A one-time token lets a machine join without a domain administrator
credential reaching the client. Redeeming it creates the host account and
returns that machine's own keytab; nothing else is handed over.
"""

from __future__ import annotations

import re
import secrets
import string
import subprocess
import tempfile
from pathlib import Path

from ldap3 import MODIFY_REPLACE, Connection

from . import objects
from .config import Settings
from .dns import SAMBA_TOOL, DnsError, DnsUnavailable, available, connection_flags, message

# The spelling samba-tool wants. "-k yes" is deprecated and says so on stdout,
# where a caller reading the output takes the notice for a line of it.
KERBEROS = "--use-kerberos=required"

TIMEOUT_SECONDS = 120
HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?"
                         r"(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$")
PASSWORD_ALPHABET = string.ascii_letters + string.digits + "@#%^*_-+="


class EnrolmentError(DnsError):
    """The machine could not be enrolled."""


def new_token() -> str:
    return secrets.token_urlsafe(32)


def machine_password() -> str:
    """A long random password for a machine account, which never types it."""
    return "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(48))


def validate_hostname(hostname: str) -> str:
    hostname = hostname.strip().lower().rstrip(".")
    if not HOSTNAME_RE.match(hostname):
        raise EnrolmentError(f"invalid host name {hostname!r}")
    return hostname


def short_name(hostname: str) -> str:
    return validate_hostname(hostname).split(".", 1)[0]


def _run(*args: str) -> str:
    if not available():
        raise DnsUnavailable(
            "samba-tool is not installed on the API host; token enrolment requires "
            "the control plane to run on a domain controller"
        )
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, validated arguments
            [SAMBA_TOOL, *args],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EnrolmentError(f"samba-tool failed: {exc}") from exc
    if completed.returncode != 0:
        raise EnrolmentError(message(completed.stderr, completed.stdout, "samba-tool failed"))
    return completed.stdout


def _directory(settings: Settings) -> list[str]:
    """How samba-tool reaches the directory.

    On a host install the control plane runs on its controller and samba-tool
    opens the directory there. In containers (docs/CONTAINERS.md) there is no
    controller beside it, so it goes over the wire as the control plane's own
    account, the way the DNS commands always have.
    """
    if settings.deployment == "container":
        return connection_flags(settings)
    return [KERBEROS]


def _add_spn(settings: Settings, principal: str, account: str) -> None:
    """Add a service principal name to an account, tolerating "already there".

    A machine re-enrolling already has this from the run before, and that is
    not a reason to fail the whole join — the same reasoning
    create-api-service-account.sh uses for the console's own SPNs.
    """
    try:
        _run("spn", "add", principal, account, *_directory(settings))
    except EnrolmentError:
        pass


def rename_machine(conn: Connection, settings: Settings, dn: str, new_short: str) -> str:
    """Give an existing computer object a new name, in place.

    The object stays where it is — same organizational unit, same group
    memberships, same policy links — and only what names it changes: the
    relative name, sAMAccountName, dNSHostName, and the service principal
    names. The account's keys are replaced afterwards by provision_machine,
    which hands the machine a keytab under the new principals. Returns the
    new distinguished name.
    """
    new_short = short_name(validate_hostname(new_short))
    canonical = objects.normalize_dn(settings, dn)
    current = objects.get(conn, settings, canonical)
    if current.get("objectType") != "computer":
        raise EnrolmentError("only a computer can be renamed this way")
    parent = canonical.split(",", 1)[1]
    new_dn = objects.move(conn, settings, canonical, parent, new_short)
    fqdn = f"{new_short}.{settings.domain}".lower()
    spns = [f"{service}/{name}" for service in ("host", "cifs") for name in (new_short, fqdn)]
    conn.modify(
        new_dn,
        {
            "sAMAccountName": [(MODIFY_REPLACE, [f"{new_short}$"])],
            "dNSHostName": [(MODIFY_REPLACE, [fqdn])],
            "servicePrincipalName": [(MODIFY_REPLACE, spns)],
        },
    )
    if conn.result and conn.result.get("result") not in (0, None):
        raise EnrolmentError(f"renaming the account: {conn.result.get('description')}")
    return new_dn


def provision_machine(settings: Settings, hostname: str, container_dn: str) -> bytes:
    """Create or reset the host account and return its keytab.

    The account password is generated here, used once to set the account, and
    never leaves this function; what the client receives is the keytab
    derived from it.

    `net ads join` — the credentialed path — registers HOST/ and cifs/ SPNs
    for the machine as part of joining. Token enrolment skips that whole
    protocol and creates the bare account here instead, so nothing else ever
    added those SPNs: a member server enrolled this way had an account with
    no service principal name at all, and every Kerberised service it tried
    to host — a file share above all — had no ticket to accept. The KDC's
    answer to a client asking for "cifs/<host>" was "Server not found in
    Kerberos database", which a cifs mount reports as nothing mounting at
    all, not as a naming problem. Registered here, and exported into the
    keytab this hands back, a member file server works the same as one
    joined by hand.
    """
    fqdn = validate_hostname(hostname)
    short = short_name(fqdn)
    account = f"{short}$"
    password = machine_password()

    where = _directory(settings)
    existing = _run("computer", "list", *where).splitlines()
    if short in {line.strip().rstrip("$") for line in existing}:
        # Re-enrolling a machine resets its account rather than failing.
        _run("user", "setpassword", account, f"--newpassword={password}", *where)
    else:
        _run(
            "computer",
            "create",
            short,
            f"--computerou={container_dn}",
            *where,
        )
        _run("user", "setpassword", account, f"--newpassword={password}", *where)

    # Both forms: a share or a drive map may name the server either way, and
    # whichever one a client asks a ticket for has to be the one the KDC
    # actually knows about.
    hostnames = dict.fromkeys((short, fqdn))
    for service in ("host", "cifs"):
        for name in hostnames:
            _add_spn(settings, f"{service}/{name}", account)

    with tempfile.TemporaryDirectory() as workspace:
        keytab = Path(workspace) / "machine.keytab"
        principals = [f"{account}@{settings.realm}"]
        principals += [
            f"{service}/{name}@{settings.realm}"
            for service in ("host", "cifs")
            for name in hostnames
        ]
        if settings.deployment == "container":
            # A controller hands out an account's keys only from its own
            # database; over the wire it refuses ("only gMSA accounts can be
            # exported over LDAP"). The password was set a moment ago, here,
            # so the keys are derived from it instead — by MIT's ktutil, with
            # the salt Active Directory gives a computer account.
            stored, kvno = _account_keys(settings, account)
            # The account's own principal as the directory spells it, and in
            # capitals: the KDC matches names either way, but a keytab entry
            # is found by its exact spelling, and an agent asks for "SRV2$"
            # whatever case the account was created in.
            spellings = dict.fromkeys((stored, stored.upper()))
            principals[0:1] = [f"{name}@{settings.realm}" for name in spellings]
            keytab.write_bytes(keytab_from_password(settings, short, password, principals, kvno))
            return keytab.read_bytes()
        for principal in principals:
            _run(
                "domain",
                "exportkeytab",
                str(keytab),
                f"--principal={principal}",
                "-k",
                "yes",
            )
        if not keytab.exists():
            raise EnrolmentError("samba-tool produced no keytab")
        return keytab.read_bytes()


# What a keytab is made with when the controller cannot be asked for one:
# the encryption types Samba gives an account by default, strongest first.
KEYTAB_ENCTYPES = ("aes256-cts-hmac-sha1-96", "aes128-cts-hmac-sha1-96")


def computer_salt(settings: Settings, short: str) -> str:
    """The salt Active Directory derives a computer account's keys with:
    the realm, "host", and the machine's lower-case name in the DNS domain
    (MS-KILE 3.1.1.2)."""
    return f"{settings.realm}host{short.lower()}.{settings.domain.lower()}"


def keytab_from_password(
    settings: Settings, short: str, password: str, principals: list[str], kvno: int
) -> bytes:
    """A keytab for every principal of one computer account, from its
    password. The password reaches ktutil on its standard input, never on a
    command line."""
    if kvno < 1:
        raise EnrolmentError("the account has no key version number")
    salt = computer_salt(settings, short)
    script = []
    for principal in principals:
        for enctype in KEYTAB_ENCTYPES:
            script.append(f"addent -password -p {principal} -k {kvno} -e {enctype} -s {salt}")
            script.append(password)
    with tempfile.TemporaryDirectory() as workspace:
        target = Path(workspace) / "machine.keytab"
        script += [f"wkt {target}", "quit", ""]
        try:
            completed = subprocess.run(  # noqa: S603 - fixed argv; the password is on stdin
                ["ktutil"],  # noqa: S607 - MIT's ktutil, from the system
                input="\n".join(script),
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise EnrolmentError(f"ktutil failed: {exc}") from exc
        if completed.returncode != 0 or not target.exists():
            raise EnrolmentError(message(completed.stderr, completed.stdout, "ktutil failed"))
        return target.read_bytes()


def _account_keys(settings: Settings, account: str) -> tuple[str, int]:
    """The account's name as the directory stores it, and its current key
    version, which a keytab entry must carry."""
    from ldap3.utils.conv import escape_filter_chars

    from . import directory

    conn = directory.service_connection(settings)
    try:
        conn.search(
            settings.base_dn,
            f"(sAMAccountName={escape_filter_chars(account)})",
            attributes=["sAMAccountName", "msDS-KeyVersionNumber"],
        )
        if not conn.entries:
            raise EnrolmentError(f"{account} was not found after it was created")
        stored = str(conn.entries[0]["sAMAccountName"].value or account)
        value = conn.entries[0]["msDS-KeyVersionNumber"].value
    finally:
        conn.unbind()
    try:
        return stored, int(value)
    except (TypeError, ValueError) as exc:
        raise EnrolmentError(f"{account} has no key version number") from exc
