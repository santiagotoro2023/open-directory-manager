-- What a machine is actually doing, as opposed to what the directory records
-- about its account.
--
-- The directory knows a computer exists. It does not know who is logged into
-- it, when it last booted, which local accounts it carries or whether it has
-- updates waiting. Its agent knows all of that, and reports it here.

CREATE TABLE computer_fact (
    computer_dn       text PRIMARY KEY,
    hostname          text NOT NULL,
    operating_system  text NOT NULL DEFAULT '',
    kernel            text NOT NULL DEFAULT '',
    booted_at         timestamptz,
    -- [{"name": "ada", "uid": 1000, "shell": "/bin/bash", "groups": [...]}]
    local_users       jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- [{"user": "ada", "line": "tty2", "since": "..."}]
    sessions          jsonb NOT NULL DEFAULT '[]'::jsonb,
    pending_updates   integer NOT NULL DEFAULT 0,
    security_updates  integer NOT NULL DEFAULT 0,
    -- Package names waiting, so an operator can see what an update would do.
    updates           jsonb NOT NULL DEFAULT '[]'::jsonb,
    updates_checked_at timestamptz,
    reported_at       timestamptz NOT NULL DEFAULT now()
);

-- Who logged on, when it booted, when it went down. Read from the machine's
-- own wtmp rather than inferred from check-ins, so a machine that was off is
-- distinguishable from one whose agent was stopped.
CREATE TABLE computer_event (
    id           bigserial PRIMARY KEY,
    computer_dn  text        NOT NULL,
    hostname     text        NOT NULL,
    kind         text        NOT NULL
                      CHECK (kind IN ('logon', 'logoff', 'boot', 'shutdown', 'update')),
    principal    text        NOT NULL DEFAULT '',
    occurred_at  timestamptz NOT NULL,
    detail       text,
    recorded_at  timestamptz NOT NULL DEFAULT now(),
    -- A report covers a window rather than a point, so the same login arrives
    -- more than once. The event is the fact, not the report of it.
    UNIQUE (computer_dn, kind, principal, occurred_at)
);

CREATE INDEX computer_event_recent_idx ON computer_event (computer_dn, occurred_at DESC);

-- Asking a machine to do something now is another kind of queued work.
ALTER TABLE node_task DROP CONSTRAINT node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'share-apply', 'share-remove',
             'update-check', 'update-install')
);

-- Managing a machine — asking it to check for or install updates — is a right
-- of its own, separate from editing its account in the directory.
INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('directory-admin', 'computer.manage'),
    ('helpdesk', 'computer.manage'),
    ('helpdesk', 'server.read')
ON CONFLICT DO NOTHING;
