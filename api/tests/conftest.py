"""Test configuration.

Settings are read from the environment at import time, so they are set here
before anything under odm/ is imported. No PostgreSQL and no domain
controller are needed: the pool and the directory are stubbed.
"""

from __future__ import annotations

import os

os.environ.update(
    {
        "ODM_REALM": "corp.example.internal",
        "ODM_DOMAIN": "corp.example.internal",
        "ODM_LDAP_URI": "ldaps://dc1.corp.example.internal",
        "ODM_LDAP_CA_CERT": "/nonexistent/ca.pem",
        "ODM_DATABASE_URL": "postgresql://odm@localhost/odm",
        "ODM_ALLOWED_ORIGINS": '["https://odm.corp.example.internal"]',
    }
)
