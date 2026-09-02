-- How often an agent asks for policy, and whether the control plane tells it
-- to ask sooner.
--
-- The interval was the control plane's own configuration file, so changing it
-- for the domain meant editing a file on the server and restarting it. It is
-- a property of the domain, set where the controllers are managed, and it
-- reaches every machine in the policy document it already fetches.
--
-- One row, because there is one domain.
CREATE TABLE IF NOT EXISTS agent_schedule (
    id             boolean PRIMARY KEY DEFAULT true CHECK (id),
    poll_minutes   integer NOT NULL DEFAULT 15 CHECK (poll_minutes IN (1, 5, 15, 30)),
    -- With this on, a policy change queues a refresh for the machines it
    -- reaches, which the agent's own wait picks up within a second. Off, the
    -- machine finds out at its next poll.
    push_enabled   boolean NOT NULL DEFAULT false,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     text NOT NULL DEFAULT ''
);

INSERT INTO agent_schedule (id) VALUES (true) ON CONFLICT DO NOTHING;

-- Setting it is a domain-wide change to how every machine behaves, so it sits
-- with the other controller-level rights rather than with directory editing.
INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('domain-admin', 'dc.write')
ON CONFLICT DO NOTHING;

-- The interval used to be seeded into the Default Domain Policy, where it
-- would have won over the setting above for every machine in the domain: the
-- console would say 5 minutes over a fleet still polling on 15. It is a domain
-- setting now, so the stale copy comes out of the policy objects carrying it.
UPDATE gpo
SET settings = settings - 'agent'
WHERE settings ? 'agent';
