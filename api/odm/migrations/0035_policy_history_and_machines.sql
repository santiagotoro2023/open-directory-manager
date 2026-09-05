-- What changed in a policy object, what a group's membership is a question
-- about, whether a session host is taking new sessions, and what a machine's
-- disks are.

-- ------------------------------------------------------- policy revisions --

-- Every save of a policy object keeps the one before it, so a change that
-- turns out to be wrong is one button rather than an operator's memory.
CREATE TABLE gpo_revision (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gpo_guid     uuid NOT NULL REFERENCES gpo (guid) ON DELETE CASCADE,
    -- The state as it was *before* the change this row records, which is what
    -- a rollback puts back.
    display_name text NOT NULL,
    description  text NOT NULL DEFAULT '',
    enabled      boolean NOT NULL DEFAULT true,
    settings     jsonb NOT NULL DEFAULT '{}'::jsonb,
    targeting    jsonb NOT NULL DEFAULT '{}'::jsonb,
    security_filter jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- What the operator did to produce the next state, in their words where
    -- there are any and in the action's otherwise.
    summary      text NOT NULL DEFAULT '',
    changed_by   text,
    changed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX gpo_revision_object_idx ON gpo_revision (gpo_guid, changed_at DESC);

-- ---------------------------------------------------------- dynamic groups --

-- A group whose membership is a query rather than a list. Recomputed on a
-- schedule and after any directory change that could affect it.
CREATE TABLE group_query (
    group_dn     text PRIMARY KEY,
    -- Where to look, and what to look for. Both are ODM's own vocabulary
    -- rather than raw LDAP: a filter typed by hand is a filter nobody can
    -- review, and one that is wrong quietly empties a group.
    scope_dn     text NOT NULL DEFAULT '',
    object_type  text NOT NULL DEFAULT 'user'
                      CHECK (object_type IN ('user', 'computer')),
    -- [{"attribute": "department", "operator": "is", "value": "Finance"}]
    conditions   jsonb NOT NULL DEFAULT '[]'::jsonb,
    match_all    boolean NOT NULL DEFAULT true,
    enabled      boolean NOT NULL DEFAULT true,
    last_run_at  timestamptz,
    last_error   text,
    member_count integer NOT NULL DEFAULT 0,
    created_by   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ remote desktop --

-- Whether a session host takes new sessions. A host being patched is drained
-- rather than removed from the collection: removing it would send everybody
-- still on it somewhere else at their next reconnect.
ALTER TABLE rd_collection_host
    ADD COLUMN IF NOT EXISTS accepts_new boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS drained_at  timestamptz,
    ADD COLUMN IF NOT EXISTS drained_by  text;

-- Two brokers keeping one affinity table between them, so somebody
-- reconnecting through the standby is still sent to the host holding their
-- session. haproxy calls this a peers section; ODM only has to give both
-- nodes the same one.
ALTER TABLE rd_collection
    ADD COLUMN IF NOT EXISTS shared_state boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------- disk encryption --

ALTER TABLE computer_fact
    -- [{"device": "/dev/nvme0n1p3", "encrypted": true, "format": "LUKS2", ...}]
    ADD COLUMN IF NOT EXISTS volumes jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A recovery passphrase for one encrypted volume on one machine.
--
-- Stored the way the local-administrator password is: readable by the control
-- plane, revealed only to somebody holding the right, and every reveal in the
-- audit log. A recovery key that ODM cannot read is a recovery key that does
-- not help at three in the morning, which is the only time one is wanted.
CREATE TABLE disk_recovery_key (
    computer_dn  text NOT NULL,
    device       text NOT NULL,
    passphrase   text NOT NULL,
    -- Where it came from: an unattended install, or an operator supplying the
    -- existing passphrase once.
    source       text NOT NULL DEFAULT 'escrow'
                      CHECK (source IN ('escrow', 'install')),
    escrowed_by  text,
    escrowed_at  timestamptz NOT NULL DEFAULT now(),
    revealed_at  timestamptz,
    revealed_by  text,
    PRIMARY KEY (computer_dn, device)
);

-- ------------------------------------------------------------------ tasks --

ALTER TABLE node_task DROP CONSTRAINT IF EXISTS node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'console-certificate',
             'share-apply', 'share-remove',
             'update-check', 'update-install',
             'package-install', 'package-remove',
             'browse', 'make-directory', 'set-permissions', 'printer-discover',
             'printer-apply', 'printer-remove', 'printer-test', 'vpn-apply',
             'radius-apply', 'rd-host-apply', 'rd-broker-apply',
             'rd-profile-list', 'rd-profile-manage',
             'domain-backup', 'local-user-add', 'local-user-remove',
             'policy-refresh', 'restart', 'shutdown',
             'agent-update', 'shell-run', 'disk-escrow')
);

-- ------------------------------------------------------------ permissions --

INSERT INTO rbac_role (name, description, builtin) VALUES
    ('read-only', 'See everything in the console and change nothing', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO rbac_role_permission (role_name, permission)
SELECT 'read-only', permission
FROM (VALUES
    ('directory.read'), ('gpo.read'), ('dns.read'), ('dhcp.read'),
    ('recyclebin.read'), ('role.read'), ('server.read'), ('printer.read'),
    ('vpn.read'), ('rd.read'), ('dc.read'), ('radius.read'), ('site.read'),
    ('share.read'), ('replication.read'), ('backup.read'), ('audit.read'),
    ('ca.read'), ('health.read'), ('policy.model'), ('gpo.revision.read'),
    ('computer.encryption.read'), ('domain.baseline')
) AS wanted(permission)
ON CONFLICT DO NOTHING;

INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('domain-admin', 'policy.model'),
    ('domain-admin', 'gpo.revision.read'),
    ('domain-admin', 'gpo.rollback'),
    ('domain-admin', 'group.query.write'),
    ('domain-admin', 'computer.encryption.read'),
    ('domain-admin', 'computer.encryption.escrow'),
    ('domain-admin', 'ca.revoke'),
    ('domain-admin', 'domain.baseline'),
    ('auditor', 'policy.model'),
    ('auditor', 'gpo.revision.read'),
    ('auditor', 'computer.encryption.read'),
    ('auditor', 'domain.baseline'),
    ('directory-admin', 'group.query.write'),
    ('ca-admin', 'ca.revoke')
ON CONFLICT DO NOTHING;
