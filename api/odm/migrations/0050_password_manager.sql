-- The password-manager role: Vaultwarden on a member server, the directory
-- deciding who gets a seat. One row of configuration for the domain, and a
-- task kind that carries it to the node.
CREATE TABLE IF NOT EXISTS password_manager (
    id                  integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    node_fqdn           text NOT NULL DEFAULT '',
    -- What people and the browser extension connect to.
    vault_url           text NOT NULL DEFAULT '',
    -- The organisation's API key, from the vault's own settings; what the
    -- directory sync signs in with.
    org_client_id       text NOT NULL DEFAULT '',
    org_client_secret   text NOT NULL DEFAULT '',
    -- The directory account the sync reads with, made by the console.
    sync_account        text NOT NULL DEFAULT '',
    sync_password       text NOT NULL DEFAULT '',
    -- Groups whose members get a seat; empty means every account.
    sync_groups         jsonb NOT NULL DEFAULT '[]'::jsonb,
    sync_every_hours    integer NOT NULL DEFAULT 1 CHECK (sync_every_hours BETWEEN 1 AND 168),
    smtp_host           text NOT NULL DEFAULT '',
    smtp_port           integer NOT NULL DEFAULT 587,
    smtp_from           text NOT NULL DEFAULT '',
    smtp_username       text NOT NULL DEFAULT '',
    smtp_password       text NOT NULL DEFAULT '',
    admin_token         text NOT NULL DEFAULT '',
    last_applied_at     timestamptz,
    last_result         text NOT NULL DEFAULT '',
    updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO password_manager (id) VALUES (1) ON CONFLICT DO NOTHING;

INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('domain-admin', 'passwords.read'),
    ('domain-admin', 'passwords.write'),
    ('auditor', 'passwords.read')
ON CONFLICT DO NOTHING;

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
             'agent-update', 'shell-run', 'disk-escrow', 'remote-assist',
             'shell-session', 'local-user-password', 'message', 'passwords-apply')
);
