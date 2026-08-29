-- Network access, and certificates that arrive on their own.

-- ----------------------------------------------------------------- radius --
-- A RADIUS client is a device that asks: a switch, an access point, a VPN
-- concentrator. Its shared secret is what proves the question came from it.
CREATE TABLE radius_client (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_fqdn   text NOT NULL,
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    -- One address or a network: a stack of switches is one entry.
    address     text NOT NULL,
    secret      text NOT NULL,
    -- Free text the device sends; used to tell one network apart from another
    -- in a policy, the way an SSID or a VPN name does.
    nas_identifier text NOT NULL DEFAULT '',
    created_by  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (node_fqdn, name)
);

-- Who may authenticate where. Evaluated in order; the first rule that matches
-- decides, and nothing matching means no.
CREATE TABLE radius_policy (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL UNIQUE,
    description   text NOT NULL DEFAULT '',
    -- The group whose members this is about, by distinguished name.
    group_dn      text NOT NULL,
    group_name    text NOT NULL DEFAULT '',
    -- What is being authenticated: a person signing in, or a machine.
    principal_kind text NOT NULL DEFAULT 'user'
                        CHECK (principal_kind IN ('user', 'computer', 'any')),
    -- Which networks. Empty means every RADIUS client this server serves.
    nas_identifiers text[] NOT NULL DEFAULT '{}',
    -- allow or deny. Deny wins wherever it matches, as it does everywhere else.
    access        text NOT NULL DEFAULT 'allow' CHECK (access IN ('allow', 'deny')),
    -- Optional VLAN to place the session in, which is most of why 802.1X
    -- is worth doing at all.
    vlan          integer,
    ordering      integer NOT NULL DEFAULT 100,
    enabled       boolean NOT NULL DEFAULT true,
    created_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX radius_policy_order_idx ON radius_policy (ordering, name);

-- ------------------------------------------------------------- enrolment ---
-- Certificates a machine or a person gets without anyone issuing one by hand.
-- The request is bound to the identity that asked: a machine may enrol for
-- itself and for nothing else.
CREATE TABLE enrolled_certificate (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    computer_dn  text NOT NULL,
    hostname     text NOT NULL,
    -- The policy entry this satisfies, so a renewal replaces the right one.
    profile      text NOT NULL,
    subject      text NOT NULL,
    serial       text NOT NULL REFERENCES ca_certificate(serial) ON DELETE CASCADE,
    not_after    timestamptz NOT NULL,
    issued_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (computer_dn, profile)
);

CREATE INDEX enrolled_certificate_expiry_idx ON enrolled_certificate (not_after);

-- --------------------------------------------------------- queued work ------
ALTER TABLE node_task DROP CONSTRAINT node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'share-apply', 'share-remove',
             'update-check', 'update-install',
             'package-install', 'package-remove',
             'policy-refresh', 'restart', 'shutdown',
             'printer-apply', 'printer-remove', 'vpn-apply',
             'radius-apply')
);

-- ------------------------------------------------------------ delegation ----
INSERT INTO rbac_role (name, description, builtin) VALUES
    ('network-admin', 'Manage network access: RADIUS clients and who may authenticate', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('network-admin', 'directory.read'),
    ('network-admin', 'server.read'),
    ('network-admin', 'radius.read'),
    ('network-admin', 'radius.write'),
    ('network-admin', 'ca.read'),
    ('directory-admin', 'radius.read'),
    ('helpdesk', 'user.password.reset'),
    ('vpn-admin', 'radius.read'),
    -- Changing your own password is a right ordinary accounts hold, not one
    -- an administrator delegates. It is here so the permission set is
    -- complete; the console gates the page on policy as well.
    ('helpdesk', 'password.self_service'),
    ('directory-admin', 'password.self_service')
ON CONFLICT DO NOTHING;
