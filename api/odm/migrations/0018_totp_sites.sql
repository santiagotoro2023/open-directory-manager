-- A second factor, and where machines are.

-- ------------------------------------------------------------------- totp --
-- One enrolment per account. The secret is what the authenticator holds; it is
-- shown once, at enrolment, and never again — a secret that can be read back
-- out of a console is one a stolen session hands over.
CREATE TABLE totp_enrolment (
    principal_sid text PRIMARY KEY,
    principal     text NOT NULL,
    secret        text NOT NULL,
    -- Enrolment is not finished until a code from the device is accepted, so
    -- nobody locks themselves out with a QR code they never scanned.
    confirmed_at  timestamptz,
    -- The last accepted step, so a code cannot be replayed inside its window.
    last_step     bigint,
    -- Single-use codes for getting back in without the device.
    recovery_codes text[] NOT NULL DEFAULT '{}',
    enrolled_by   text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ sites --
-- Sites are part of the directory itself, not a role: every domain has one
-- from the moment it is provisioned. A subnet maps a machine's address to a
-- site, and a site says which controllers are near it.
CREATE TABLE ad_site (
    name        text PRIMARY KEY,
    description text NOT NULL DEFAULT '',
    created_by  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ad_subnet (
    cidr        text PRIMARY KEY,
    site_name   text NOT NULL REFERENCES ad_site(name) ON DELETE CASCADE,
    description text NOT NULL DEFAULT '',
    created_by  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ad_subnet_site_idx ON ad_subnet (site_name);

-- Which controllers serve a site. Recorded here rather than read from the
-- directory's own configuration partition, because moving a controller
-- between sites in Samba is a manual operation and this is what ODM knows.
CREATE TABLE ad_site_controller (
    controller_dn text NOT NULL,
    site_name     text NOT NULL REFERENCES ad_site(name) ON DELETE CASCADE,
    hostname      text NOT NULL DEFAULT '',
    assigned_by   text,
    assigned_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (controller_dn)
);

CREATE INDEX ad_site_controller_site_idx ON ad_site_controller (site_name);

-- What site a machine reported itself in, worked out from the addresses its
-- agent sends. Kept so the console can show where a machine thinks it is.
ALTER TABLE computer_fact
    ADD COLUMN addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN site_name text;

-- ------------------------------------------------------- password policies --
-- A fine-grained password policy, as the directory calls it. ODM keeps the
-- definition; Samba holds the object that enforces it.
CREATE TABLE password_policy (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text NOT NULL UNIQUE,
    description  text NOT NULL DEFAULT '',
    -- Lower wins where two policies reach the same account, as in AD.
    precedence   integer NOT NULL DEFAULT 100,
    complexity   boolean NOT NULL DEFAULT true,
    min_length   integer NOT NULL DEFAULT 12,
    history      integer NOT NULL DEFAULT 5,
    min_age_days integer NOT NULL DEFAULT 0,
    max_age_days integer NOT NULL DEFAULT 0,
    lockout_threshold integer NOT NULL DEFAULT 0,
    lockout_minutes   integer NOT NULL DEFAULT 30,
    -- Groups it is applied to, and organizational units whose users it should
    -- reach. AD applies these to users and groups, never to a container, so an
    -- organizational unit is resolved to the users beneath it and re-resolved
    -- as people are added.
    group_dns    text[] NOT NULL DEFAULT '{}',
    container_dns text[] NOT NULL DEFAULT '{}',
    applied_to   text[] NOT NULL DEFAULT '{}',
    state        text NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending', 'active', 'failed')),
    last_error   text,
    created_by   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ delegation ----
INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('directory-admin', 'site.read'),
    ('directory-admin', 'site.write'),
    ('directory-admin', 'password.policy.write'),
    ('helpdesk', 'site.read'),
    ('backup-operator', 'site.read'),
    ('network-admin', 'site.read')
ON CONFLICT DO NOTHING;
