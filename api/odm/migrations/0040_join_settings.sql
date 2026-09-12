-- Where a machine's computer object lands when nothing about the join names
-- an organizational unit — set here rather than left as Samba's built-in
-- "Computers" container, which is where every join that does not ask for
-- somewhere else still ends up otherwise.
--
-- One row, because there is one domain. Empty is "wherever Samba already
-- puts it", which keeps a fresh install behaving exactly as it always has
-- until an operator actually sets one.
CREATE TABLE IF NOT EXISTS join_settings (
    id                          boolean PRIMARY KEY DEFAULT true CHECK (id),
    default_computer_container  text NOT NULL DEFAULT '',
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    updated_by                  text NOT NULL DEFAULT ''
);

INSERT INTO join_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

-- Setting it is a domain-wide change to how every future join behaves, so it
-- sits with the other controller-level rights, the same as the agent poll
-- schedule.
INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('domain-admin', 'dc.write')
ON CONFLICT DO NOTHING;
