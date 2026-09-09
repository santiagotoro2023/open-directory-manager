-- What a machine is, and what its disks think of themselves. Model and serial
-- are what a warranty case needs; the disks are what says to raise one before
-- the machine stops.
ALTER TABLE computer_fact
    ADD COLUMN IF NOT EXISTS hardware jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS disks jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Watching somebody's screen, with their consent, is a new kind of queued
-- work and the constraint has to know about it.
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
             'agent-update', 'shell-run', 'disk-escrow', 'remote-assist')
);
