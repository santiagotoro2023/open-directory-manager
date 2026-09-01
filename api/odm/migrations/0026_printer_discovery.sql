-- Scanning for printers on demand.
--
-- The list rides the check-in already, but a print server installed a minute
-- ago has not checked in yet, and an operator who has just plugged a printer
-- in should not wait a quarter of an hour to see it.

ALTER TABLE node_task DROP CONSTRAINT node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'console-certificate',
             'share-apply', 'share-remove',
             'update-check', 'update-install',
             'package-install', 'package-remove',
             'browse', 'make-directory', 'printer-discover',
             'local-user-add', 'local-user-remove',
             'policy-refresh', 'restart', 'shutdown',
             'printer-apply', 'printer-remove', 'vpn-apply',
             'radius-apply', 'rd-host-apply', 'rd-broker-apply')
);
