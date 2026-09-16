-- A message shown on a machine's desktops is a new kind of queued work, and
-- the firmware fwupd could update joins what a machine reports about itself.
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
             'shell-session', 'local-user-password', 'message')
);

ALTER TABLE computer_fact ADD COLUMN IF NOT EXISTS firmware TEXT NOT NULL DEFAULT '[]';
