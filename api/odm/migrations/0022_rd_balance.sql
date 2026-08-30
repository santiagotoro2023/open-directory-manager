-- How a collection spreads people who do not already have a session.
--
-- Someone reconnecting always goes back to the host they were on — that is
-- what the broker's affinity is for. This is the other case: a person with no
-- session yet, who can land on any host in the collection because their
-- profile is a disk on the share rather than files on one machine.
ALTER TABLE rd_collection
    ADD COLUMN balance_method text NOT NULL DEFAULT 'leastconn'
        CHECK (balance_method IN ('leastconn', 'roundrobin', 'first'));
