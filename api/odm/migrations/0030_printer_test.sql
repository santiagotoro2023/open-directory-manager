-- A test page is queued for the print server like any other work, so the kind
-- has to be one the table accepts: the constraint is what a forgotten kind
-- fails on, with a check violation and nothing for the operator to act on.
ALTER TABLE node_task DROP CONSTRAINT node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'console-certificate',
             'share-apply', 'share-remove',
             'update-check', 'update-install',
             'package-install', 'package-remove',
             'browse', 'make-directory', 'printer-discover',
             'local-user-add', 'local-user-remove',
             'policy-refresh', 'restart', 'shutdown',
             'printer-apply', 'printer-remove', 'printer-test', 'vpn-apply',
             'radius-apply', 'rd-host-apply', 'rd-broker-apply',
             'domain-backup')
);
