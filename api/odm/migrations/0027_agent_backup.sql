-- The controller's own agent takes the domain backup.
--
-- samba-tool domain backup online replicates the whole directory over
-- DRSUAPI, which needs rights close to a Domain Admin's. The control plane's
-- account deliberately does not hold them, so every backup failed with
-- WERR_DS_DRA_ACCESS_DENIED — and granting them would have been the wrong
-- fix. Offline, as root on the controller, needs nothing in the directory.

ALTER TABLE node_task DROP CONSTRAINT node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'console-certificate',
             'share-apply', 'share-remove',
             'update-check', 'update-install',
             'package-install', 'package-remove',
             'browse', 'make-directory', 'printer-discover',
             'domain-backup',
             'local-user-add', 'local-user-remove',
             'policy-refresh', 'restart', 'shutdown',
             'printer-apply', 'printer-remove', 'vpn-apply',
             'radius-apply', 'rd-host-apply', 'rd-broker-apply')
);
