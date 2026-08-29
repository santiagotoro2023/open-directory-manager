-- Delegating the estate: who may see the servers, and who may manage shares.

INSERT INTO rbac_role (name, description, builtin) VALUES
    ('file-server-admin', 'Create and manage file shares and their permissions', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('file-server-admin', 'directory.read'),
    ('file-server-admin', 'server.read'),
    ('file-server-admin', 'share.read'),
    ('file-server-admin', 'share.write'),
    ('file-server-admin', 'health.read'),
    -- Everyone who already administers a role needs to see which machine
    -- carries it, or the roles they hold cannot be reasoned about.
    ('directory-admin', 'server.read'),
    ('dhcp-admin', 'server.read'),
    ('dns-admin', 'server.read'),
    ('ca-admin', 'server.read'),
    ('backup-operator', 'server.read')
ON CONFLICT DO NOTHING;
