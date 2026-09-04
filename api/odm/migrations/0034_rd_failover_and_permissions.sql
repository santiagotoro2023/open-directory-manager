-- Two brokers for a collection, one name clients connect to, and changing
-- what a file on a machine is owned by.
--
-- A collection used to name exactly one broker, which made the machine
-- fronting it the single thing whose loss took the whole collection away. A
-- second broker is optional and carries the same routing, so either can serve
-- the same session hosts.
--
-- The external name is what goes in the .rdp file instead of a broker's own
-- host name. ODM publishes it in the domain's DNS pointing at the brokers, so
-- a collection can be reached at remote.example.org whichever machine is
-- actually fronting it — and the address in everybody's connection file
-- survives replacing that machine.

ALTER TABLE rd_collection
    ADD COLUMN IF NOT EXISTS broker_secondary_fqdn text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS external_fqdn         text NOT NULL DEFAULT '',
    -- Whether ODM keeps the external name's records in the domain's DNS. Off
    -- for a name somebody publishes elsewhere — a public zone, a load
    -- balancer — where writing records here would be wrong rather than
    -- helpful.
    ADD COLUMN IF NOT EXISTS external_dns          boolean NOT NULL DEFAULT true;

-- Reading and changing what a file on a machine is owned by, from the console.
ALTER TABLE node_task DROP CONSTRAINT IF EXISTS node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'console-certificate',
             'share-apply', 'share-remove',
             'update-check', 'update-install',
             'package-install', 'package-remove',
             'browse', 'make-directory', 'set-permissions', 'printer-discover',
             'printer-apply', 'printer-remove', 'printer-test', 'vpn-apply',
             'radius-apply', 'rd-host-apply', 'rd-broker-apply',
             'domain-backup', 'local-user-add', 'local-user-remove',
             'policy-refresh', 'restart', 'shutdown',
             'agent-update', 'shell-run')
);

-- Exporting the whole configuration, and putting it back. Its own right: the
-- export is every setting in the domain in one file, which is exactly what an
-- auditor should be able to read and exactly what nobody else should.
INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('domain-admin', 'domain.export'),
    ('domain-admin', 'domain.import'),
    ('auditor', 'domain.export')
ON CONFLICT DO NOTHING;
