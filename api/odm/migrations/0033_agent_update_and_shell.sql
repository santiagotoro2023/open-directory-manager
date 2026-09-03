-- Updating an agent, and running a command, without signing in to the machine.
--
-- Both ride the queue every other remote job uses: the control plane can only
-- run a subprocess on its own host, and the machine's agent already proves
-- who it is with the identity domain join gave it.

ALTER TABLE node_task DROP CONSTRAINT IF EXISTS node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'console-certificate',
             'share-apply', 'share-remove',
             'update-check', 'update-install',
             'package-install', 'package-remove',
             'browse', 'make-directory', 'printer-discover',
             'printer-apply', 'printer-remove', 'printer-test', 'vpn-apply',
             'radius-apply', 'rd-host-apply', 'rd-broker-apply',
             'domain-backup', 'local-user-add', 'local-user-remove',
             'policy-refresh', 'restart', 'shutdown',
             'agent-update', 'shell-run')
);

-- Running a command on a machine as root is not something that comes with
-- being able to read a computer object, so it is its own right. Held by the
-- same role that can already install a role on that machine — which is the
-- same power by a longer route — and separable from it for a delegated
-- administrator who should have one and not the other.
INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('domain-admin', 'computer.shell')
ON CONFLICT DO NOTHING;
