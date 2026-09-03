"""Runtime configuration.

Secrets never live in the repo or in the unit file: they come from a
mode-0600 secrets file (CLAUDE.md §6) whose KEY=VALUE lines are loaded into
the environment before settings are read. Anything already present in the
environment wins, so a secrets manager can inject values instead.
"""

from __future__ import annotations

import os
import stat
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SECRETS_FILE_ENV = "ODM_SECRETS_FILE"


def derive_base_dn(domain: str) -> str:
    """corp.example.internal -> DC=corp,DC=example,DC=internal"""
    labels = [label for label in domain.strip(".").split(".") if label]
    if not labels:
        raise ValueError("domain must contain at least one label")
    return ",".join(f"DC={label}" for label in labels)


def load_secrets_file(path: Path) -> dict[str, str]:
    """Parse a KEY=VALUE secrets file.

    Group *read* is allowed so the file can be root-owned and readable by the
    service user (0640 root:odm); anything wider is refused.
    """
    mode = path.stat().st_mode
    if mode & (stat.S_IWGRP | stat.S_IXGRP | stat.S_IRWXO):
        raise PermissionError(
            f"{path} must not be group-writable or world-accessible (chmod 640)"
        )
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep:
            raise ValueError(f"malformed line in {path}: {raw!r}")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ODM_", extra="ignore")

    # --- Domain ---
    realm: str = Field(description="Kerberos realm, e.g. CORP.EXAMPLE.INTERNAL")
    domain: str = Field(description="DNS domain, e.g. corp.example.internal")
    base_dn: str = ""
    admin_group: str = Field(
        default="Domain Admins",
        description="Group whose members may sign in to the ODM web UI",
    )

    # --- LDAP ---
    ldap_uri: str = Field(description="ldaps:// URI of a domain controller")
    ldap_ca_cert: Path = Field(description="CA certificate that signs the DC's LDAPS cert")
    ldap_timeout_seconds: int = 10

    # --- Kerberos (agent/SSO SPNEGO) ---
    keytab: Path | None = None
    service_name: str = "HTTP"
    service_account: str = Field(
        default="svc-odm-api",
        description=(
            "sAMAccountName the control plane authenticates as. Active Directory "
            "issues a ticket-granting ticket to an account, never to one of its "
            "service principal names, so this is the name the keytab is read under."
        ),
    )

    # --- Group Policy ---
    # Set only when the API runs on a domain controller: enables mirroring
    # policy objects into LDAP and SYSVOL for GPMC/RSAT interoperability.
    # Unset, GPOs are ODM-only and live entirely in PostgreSQL.
    sysvol_path: Path | None = None
    agent_refresh_minutes: int = 15

    # The agent binary this console hands out when a machine is told to
    # update. The one the setup script installs and rebuilds beside the API,
    # so what a machine gets is what this console was deployed with.
    agent_binary: Path | None = Path("/usr/sbin/odm-agent")

    # --- DHCP (ISC Kea Control Agent) ---
    # Unset until the DHCP role is installed; the endpoints then report the
    # role as unavailable rather than failing obscurely.
    kea_url: str | None = None
    kea_user: str | None = None
    kea_password: str | None = None
    kea_ca_cert: Path | None = None

    # --- Certificate authority ---
    # The directory the certificate-authority role creates. It used to default
    # to nothing, so a role installed from the console reported itself "not
    # configured" until somebody hand-edited the secrets file — for a path
    # that had only ever had one value. Whether an authority actually exists
    # is decided by whether the key is on disk, not by this being set.
    ca_dir: Path | None = Path("/var/lib/odm/ca")

    # --- Backups ---
    backup_dir: Path | None = None
    backup_interval_hours: int = 24
    backup_keep: int = 14

    # --- Database ---
    database_url: str = Field(description="postgresql://user:pass@host/db")
    db_pool_min: int = 1
    db_pool_max: int = 10

    # --- Sessions / login hardening ---
    session_ttl_minutes: int = 480
    session_idle_minutes: int = 60
    session_cookie_name: str = "odm_session"
    cookie_secure: bool = True
    login_max_failures: int = 5
    login_lockout_minutes: int = 15
    admin_recheck_minutes: int = 5

    # --- Web ---
    # Where the built console lives. Set, the control plane serves it, so the
    # console and the API share an origin without a proxy in front.
    console_dir: Path | None = None
    allowed_origins: list[str] = Field(
        default_factory=list,
        description="Exact origins allowed to call the API (the UI's own origin)",
    )

    # --- Recycle bin (CLAUDE.md §3.9 / §10) ---
    retention_days: int = 180

    @field_validator("realm")
    @classmethod
    def _upper_realm(cls, v: str) -> str:
        return v.strip().upper()

    @field_validator("ldap_uri")
    @classmethod
    def _require_tls(cls, v: str) -> str:
        # CLAUDE.md §6: no plaintext LDAP, ever.
        if not v.startswith("ldaps://"):
            raise ValueError("ldap_uri must use ldaps://")
        return v

    @field_validator("kea_url")
    @classmethod
    def _kea_transport(cls, v: str | None) -> str | None:
        """Plaintext only over the loopback, where there is no wire to sniff."""
        if v is None:
            return None
        if v.startswith("https://"):
            return v
        host = v.removeprefix("http://").split("/")[0].split(":")[0]
        if v.startswith("http://") and host in ("127.0.0.1", "::1", "localhost"):
            return v
        raise ValueError("kea_url must use https, or http on the loopback address")

    @model_validator(mode="after")
    def _defaults(self) -> Settings:
        if not self.base_dn:
            self.base_dn = derive_base_dn(self.domain)
        return self


@lru_cache
def get_settings() -> Settings:
    secrets_path = os.environ.get(SECRETS_FILE_ENV)
    if secrets_path:
        for key, value in load_secrets_file(Path(secrets_path)).items():
            os.environ.setdefault(key, value)
    return Settings()  # type: ignore[call-arg]
