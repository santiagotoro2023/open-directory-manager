-- What is installed on a machine, and what an operator may do about it.

ALTER TABLE computer_fact
    -- [{"name": "wireshark", "version": "4.2.2-1"}] — the packages somebody
    -- asked for, not the thousands pulled in as dependencies. "What was put on
    -- this machine" is the question an operator actually has.
    ADD COLUMN packages jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN package_count integer NOT NULL DEFAULT 0;

ALTER TABLE node_task DROP CONSTRAINT node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'share-apply', 'share-remove',
             'update-check', 'update-install',
             'package-install', 'package-remove',
             'policy-refresh', 'restart', 'shutdown')
);

-- Restarting a machine is not the same right as reading what is on it.
INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('directory-admin', 'computer.power')
ON CONFLICT DO NOTHING;
