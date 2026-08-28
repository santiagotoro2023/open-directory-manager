-- Every permission reachable through a built-in role.
--
-- A permission no role can hold could only be delegated by first defining a
-- custom role, so the built-ins are extended to cover the whole set. The two
-- actions reserved for domain administrators — managing delegation and
-- installing server roles — are deliberately not in any role.

INSERT INTO rbac_role (name, description, builtin) VALUES
    ('directory-admin',  'Full directory management within the assigned scope', true),
    ('ca-admin',         'Issue and revoke certificates from the domain authority', true),
    ('backup-operator',  'Take backups and force replication', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO rbac_role_permission (role_name, permission) VALUES
    -- Helpdesk gains the deletes it needs; every delete is recoverable from
    -- the recycle bin, and the role is always scoped to an organizational unit.
    ('helpdesk', 'group.write'),
    ('helpdesk', 'object.delete'),
    ('helpdesk', 'recyclebin.restore'),
    ('helpdesk', 'health.read'),

    ('auditor', 'ca.read'),
    ('auditor', 'health.read'),

    ('dns-admin', 'health.read'),
    ('dhcp-admin', 'health.read'),
    ('policy-admin', 'health.read'),

    ('directory-admin', 'directory.read'),
    ('directory-admin', 'user.write'),
    ('directory-admin', 'user.password.reset'),
    ('directory-admin', 'group.write'),
    ('directory-admin', 'group.member.write'),
    ('directory-admin', 'computer.write'),
    ('directory-admin', 'ou.write'),
    ('directory-admin', 'object.move'),
    ('directory-admin', 'object.delete'),
    ('directory-admin', 'recyclebin.read'),
    ('directory-admin', 'recyclebin.restore'),
    ('directory-admin', 'recyclebin.purge'),
    ('directory-admin', 'audit.read'),
    ('directory-admin', 'health.read'),

    ('ca-admin', 'directory.read'),
    ('ca-admin', 'ca.read'),
    ('ca-admin', 'ca.issue'),
    ('ca-admin', 'health.read'),

    ('backup-operator', 'backup.read'),
    ('backup-operator', 'backup.write'),
    ('backup-operator', 'replication.read'),
    ('backup-operator', 'replication.replicate'),
    ('backup-operator', 'health.read')
ON CONFLICT DO NOTHING;
