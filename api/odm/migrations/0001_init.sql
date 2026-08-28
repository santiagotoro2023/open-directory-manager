-- ODM metadata store.
--
-- This database is NEVER the source of truth for directory objects; those
-- live in Samba's LDAP. Here we keep only what AD itself has no home for:
-- the audit trail, RBAC/delegation, the recycle bin, the role registry, the
-- GPO link/precedence cache, and web-UI session state.

-- ---------------------------------------------------------------- audit ---
-- Append-only. Every write through the API lands here with actor, time and
-- a before/after diff (CLAUDE.md §3.11, §6).
CREATE TABLE audit_log (
    id             bigserial PRIMARY KEY,
    occurred_at    timestamptz NOT NULL DEFAULT now(),
    actor          text        NOT NULL,           -- userPrincipalName or service principal
    actor_sid      text,
    source_ip      inet,
    action         text        NOT NULL,           -- e.g. auth.login, user.create, gpo.link
    object_type    text,                           -- user | group | computer | ou | gpo | role | session
    object_dn      text,
    outcome        text        NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
    detail         text,
    before_state   jsonb,
    after_state    jsonb
);

CREATE INDEX audit_log_occurred_at_idx ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_actor_idx       ON audit_log (actor, occurred_at DESC);
CREATE INDEX audit_log_object_dn_idx   ON audit_log (object_dn, occurred_at DESC);
CREATE INDEX audit_log_action_idx      ON audit_log (action, occurred_at DESC);

CREATE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_mutate
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ------------------------------------------------------------- sessions ---
-- Only the SHA-256 of the session token is stored, so a database read does
-- not yield usable cookies.
CREATE TABLE admin_session (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_sha256   text        NOT NULL UNIQUE,
    csrf_token     text        NOT NULL,
    principal      text        NOT NULL,           -- userPrincipalName
    principal_dn   text        NOT NULL,
    principal_sid  text,
    display_name   text,
    source_ip      inet,
    user_agent     text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    revoked_at     timestamptz
);

CREATE INDEX admin_session_expires_idx   ON admin_session (expires_at);
CREATE INDEX admin_session_principal_idx ON admin_session (principal);

-- Failed-login tracking for rate limiting and lockout (CLAUDE.md §6).
CREATE TABLE login_attempt (
    id           bigserial PRIMARY KEY,
    occurred_at  timestamptz NOT NULL DEFAULT now(),
    username     text        NOT NULL,
    source_ip    inet,
    succeeded    boolean     NOT NULL,
    reason       text
);

CREATE INDEX login_attempt_username_idx ON login_attempt (lower(username), occurred_at DESC);
CREATE INDEX login_attempt_ip_idx       ON login_attempt (source_ip, occurred_at DESC);

-- ----------------------------------------------------------------- RBAC ---
-- Delegated administration (CLAUDE.md §4): roles carry permissions and are
-- assigned to a directory principal at an OU scope. Modelled from day one
-- even though v1's UI only exposes the built-in domain-admin gate.
CREATE TABLE rbac_role (
    name         text PRIMARY KEY,
    description  text NOT NULL DEFAULT '',
    builtin      boolean NOT NULL DEFAULT false
);

CREATE TABLE rbac_role_permission (
    role_name    text NOT NULL REFERENCES rbac_role (name) ON DELETE CASCADE,
    permission   text NOT NULL,                    -- e.g. user.create, gpo.link, dhcp.scope.write
    PRIMARY KEY (role_name, permission)
);

CREATE TABLE rbac_assignment (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role_name      text NOT NULL REFERENCES rbac_role (name) ON DELETE CASCADE,
    principal_sid  text NOT NULL,                  -- user or group objectSid
    principal_name text NOT NULL,
    scope_dn       text NOT NULL,                  -- OU/domain DN the role applies beneath
    granted_by     text NOT NULL,
    granted_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (role_name, principal_sid, scope_dn)
);

CREATE INDEX rbac_assignment_principal_idx ON rbac_assignment (principal_sid);
CREATE INDEX rbac_assignment_scope_idx     ON rbac_assignment (scope_dn);

INSERT INTO rbac_role (name, description, builtin) VALUES
    ('domain-admin', 'Full control of the domain and every ODM role', true),
    ('helpdesk',     'Manage user and computer objects within the assigned scope', true),
    ('auditor',      'Read-only access to objects, policy and the audit log', true);

INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('domain-admin', '*'),
    ('helpdesk', 'user.read'), ('helpdesk', 'user.write'),
    ('helpdesk', 'computer.read'), ('helpdesk', 'computer.write'),
    ('helpdesk', 'group.read'), ('helpdesk', 'group.member.write'),
    ('auditor', 'user.read'), ('auditor', 'group.read'), ('auditor', 'computer.read'),
    ('auditor', 'gpo.read'), ('auditor', 'audit.read');

-- -------------------------------------------------------- role registry ---
-- Installable server roles (CLAUDE.md §3.10, §5.5). Core (AD + GPO + DNS)
-- is always present; DHCP and file-server are added after install.
CREATE TABLE server_role (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role_name      text NOT NULL,                  -- core | dhcp | file-server | ca | ...
    node_fqdn      text NOT NULL,
    state          text NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'installing', 'active', 'failed', 'removed')),
    version        text,
    config         jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_error     text,
    installed_by   text,
    installed_at   timestamptz,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (role_name, node_fqdn)
);

-- ----------------------------------------------------------- recycle bin ---
-- API-level retention (CLAUDE.md §5.3): full object state plus linked
-- attributes are snapshotted before the underlying Samba delete runs.
CREATE TABLE deleted_object (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    object_dn     text        NOT NULL,
    object_type   text        NOT NULL,
    object_guid   uuid,
    object_sid    text,
    display_name  text,
    parent_dn     text        NOT NULL,
    attributes    jsonb       NOT NULL,            -- full attribute snapshot
    memberships   jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- groups the object was in
    members       jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- members, when it was a group
    linked_gpos   jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- GPO links, when it was an OU
    deleted_by    text        NOT NULL,
    deleted_at    timestamptz NOT NULL DEFAULT now(),
    purge_after   timestamptz NOT NULL,
    restored_at   timestamptz,
    restored_by   text,
    purged_at     timestamptz
);

CREATE INDEX deleted_object_purge_idx  ON deleted_object (purge_after)
    WHERE restored_at IS NULL AND purged_at IS NULL;
CREATE INDEX deleted_object_dn_idx     ON deleted_object (object_dn);

-- ------------------------------------------------- GPO link / precedence ---
-- Cache of SYSVOL/LDAP truth so precedence can be resolved in one query.
-- Samba's LDAP remains authoritative; these rows are refreshed from it.
CREATE TABLE gpo (
    guid          uuid PRIMARY KEY,
    display_name  text NOT NULL,
    enabled       boolean NOT NULL DEFAULT true,
    version       integer NOT NULL DEFAULT 0,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ou_policy_state (
    ou_dn              text PRIMARY KEY,
    block_inheritance  boolean NOT NULL DEFAULT false,
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gpo_link (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gpo_guid    uuid NOT NULL REFERENCES gpo (guid) ON DELETE CASCADE,
    target_dn   text NOT NULL,                     -- OU, domain or site DN
    link_order  integer NOT NULL,                  -- 1 = highest precedence at this target
    enforced    boolean NOT NULL DEFAULT false,    -- "No Override"
    enabled     boolean NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (gpo_guid, target_dn),
    UNIQUE (target_dn, link_order) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX gpo_link_target_idx ON gpo_link (target_dn, link_order);
