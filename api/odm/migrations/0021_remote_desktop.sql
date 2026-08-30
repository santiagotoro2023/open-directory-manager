-- Remote desktop: collections, the hosts that serve them, and who is on them.
--
-- Modelled on the Windows concept an administrator already knows. A broker
-- fronts a collection; the collection is a set of session hosts serving the
-- same thing to the same people; a user always lands on the host they were
-- last on, so a reconnect resumes rather than starts again.
--
-- Everything that is a decision lives on the collection, because that is
-- where an administrator makes it once for everybody. What belongs to a
-- single machine — which desktop, which display driver — is the session-host
-- role's own configuration and not here.

CREATE TABLE rd_collection (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL UNIQUE,
    description   text NOT NULL DEFAULT '',
    -- The machine running the broker. Clients connect here, never to a host.
    broker_fqdn   text NOT NULL,

    -- A whole desktop, or one published application (Windows RemoteApp).
    kind          text NOT NULL DEFAULT 'desktop'
                       CHECK (kind IN ('desktop', 'remoteapp')),
    app_path      text NOT NULL DEFAULT '',
    app_name      text NOT NULL DEFAULT '',

    -- Profile disks. There is no local-profile option on purpose: a profile
    -- that stays on whichever host answered is a profile that differs per
    -- host, and the whole point of a collection is that it does not matter
    -- which host answered.
    profile_share text NOT NULL,
    profile_gb    integer NOT NULL DEFAULT 10 CHECK (profile_gb BETWEEN 1 AND 2048),

    -- What ends a session. Zero means never, as it does in Windows.
    idle_minutes         integer NOT NULL DEFAULT 60  CHECK (idle_minutes BETWEEN 0 AND 10080),
    disconnected_minutes integer NOT NULL DEFAULT 120 CHECK (disconnected_minutes BETWEEN 0 AND 10080),
    max_sessions_per_host integer NOT NULL DEFAULT 0  CHECK (max_sessions_per_host BETWEEN 0 AND 1000),

    -- Who may connect. Empty means nobody: a collection reachable by everyone
    -- is not a default anybody should get by leaving a field alone.
    principals    jsonb NOT NULL DEFAULT '[]'::jsonb,

    state         text NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'applying', 'active', 'failed')),
    last_error    text,
    created_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Which hosts serve a collection. A host may serve exactly one: two
-- collections on one machine would share a desktop and a profile share while
-- claiming not to.
CREATE TABLE rd_collection_host (
    collection_id uuid NOT NULL REFERENCES rd_collection (id) ON DELETE CASCADE,
    node_fqdn     text NOT NULL UNIQUE,
    added_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection_id, node_fqdn)
);

-- The session directory. Reported by the hosts, so it says what is actually
-- running rather than what was asked for.
CREATE TABLE rd_session (
    node_fqdn     text NOT NULL,
    username      text NOT NULL,
    display       text NOT NULL DEFAULT '',
    state         text NOT NULL DEFAULT 'active'
                       CHECK (state IN ('active', 'disconnected')),
    started_at    timestamptz,
    reported_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (node_fqdn, username)
);

CREATE INDEX rd_session_user_idx ON rd_session (lower(username));

INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('domain-admin', 'rd.read'),
    ('domain-admin', 'rd.write'),
    ('auditor', 'rd.read')
ON CONFLICT DO NOTHING;
