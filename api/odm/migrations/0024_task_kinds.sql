-- The kinds a task may be, brought back into line with the kinds the control
-- plane actually queues.
--
-- The check constraint was last widened in 0017. Four features have added a
-- task kind since and none of them widened it, so replacing the console
-- certificate, configuring a session host or a broker, and everything added
-- with them, failed with a check violation the moment the row was written —
-- a 500 with nothing to act on. tests/test_surface.py now compares this list
-- against tasks.KINDS, so the next one cannot be forgotten quietly.

ALTER TABLE node_task DROP CONSTRAINT node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'console-certificate',
             'share-apply', 'share-remove',
             'update-check', 'update-install',
             'package-install', 'package-remove',
             'browse', 'make-directory',
             'local-user-add', 'local-user-remove',
             'policy-refresh', 'restart', 'shutdown',
             'printer-apply', 'printer-remove', 'vpn-apply',
             'radius-apply', 'rd-host-apply', 'rd-broker-apply')
);
