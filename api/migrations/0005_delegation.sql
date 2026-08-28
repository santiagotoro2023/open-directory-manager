-- Delegated administration (CLAUDE.md §4).
--
-- Sessions record what the directory said at sign-in, so authorisation does
-- not need an LDAP round trip per request, and the built-in roles are
-- re-seeded against the permission names the API actually checks.

ALTER TABLE admin_session
    ADD COLUMN is_domain_admin boolean NOT NULL DEFAULT true,
    ADD COLUMN group_sids      text[]  NOT NULL DEFAULT '{}';

ALTER TABLE rbac_assignment
    ADD COLUMN description text NOT NULL DEFAULT '';

CREATE INDEX admin_session_group_sids_idx ON admin_session USING gin (group_sids);

DELETE FROM rbac_role_permission;

INSERT INTO rbac_role (name, description, builtin) VALUES
    ('dns-admin',    'Manage DNS zones and records', true),
    ('dhcp-admin',   'Manage DHCP scopes, reservations and leases', true),
    ('policy-admin', 'Manage group policy objects, links and templates', true)
ON CONFLICT (name) DO NOTHING;

UPDATE rbac_role SET description = 'Manage users, hosts and group membership within the assigned scope'
WHERE name = 'helpdesk';

INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('domain-admin', '*'),

    ('helpdesk', 'directory.read'),
    ('helpdesk', 'user.write'),
    ('helpdesk', 'user.password.reset'),
    ('helpdesk', 'computer.write'),
    ('helpdesk', 'group.member.write'),
    ('helpdesk', 'object.move'),
    ('helpdesk', 'recyclebin.read'),
    ('helpdesk', 'audit.read'),

    ('auditor', 'directory.read'),
    ('auditor', 'gpo.read'),
    ('auditor', 'dns.read'),
    ('auditor', 'dhcp.read'),
    ('auditor', 'role.read'),
    ('auditor', 'recyclebin.read'),
    ('auditor', 'replication.read'),
    ('auditor', 'backup.read'),
    ('auditor', 'audit.read'),

    ('dns-admin', 'directory.read'),
    ('dns-admin', 'dns.read'),
    ('dns-admin', 'dns.write'),

    ('dhcp-admin', 'directory.read'),
    ('dhcp-admin', 'dhcp.read'),
    ('dhcp-admin', 'dhcp.write'),

    ('policy-admin', 'directory.read'),
    ('policy-admin', 'gpo.read'),
    ('policy-admin', 'gpo.write'),
    ('policy-admin', 'admx.write');
