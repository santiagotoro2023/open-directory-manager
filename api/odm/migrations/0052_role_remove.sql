-- Removing a role from a node is a task the node's agent carries out
-- (uninstall.sh --role <name>), not a record the console quietly forgets.
ALTER TABLE node_task DROP CONSTRAINT IF EXISTS node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'role-remove', 'console-certificate',
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

ALTER TABLE server_role DROP CONSTRAINT IF EXISTS server_role_state_check;
ALTER TABLE server_role ADD CONSTRAINT server_role_state_check
    CHECK (state IN ('pending', 'installing', 'active', 'failed', 'removing', 'removed'));
