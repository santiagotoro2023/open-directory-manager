-- Printing, remote access, and what a machine's journal says.

-- ------------------------------------------------------------------- logs --
-- Warnings and above, plus whatever units policy names. Not a log pipeline:
-- enough to answer "why is this machine unhappy" from the machine's own page,
-- kept for a window and then dropped.
CREATE TABLE computer_log (
    id          bigserial PRIMARY KEY,
    computer_dn text        NOT NULL,
    hostname    text        NOT NULL,
    unit        text        NOT NULL DEFAULT '',
    priority    integer     NOT NULL DEFAULT 6,
    message     text        NOT NULL,
    occurred_at timestamptz NOT NULL,
    -- The journal's own cursor, so the same entry arriving twice is one row.
    cursor      text        NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (computer_dn, cursor)
);

CREATE INDEX computer_log_recent_idx ON computer_log (computer_dn, occurred_at DESC);
CREATE INDEX computer_log_unit_idx   ON computer_log (computer_dn, unit, occurred_at DESC);

-- --------------------------------------------------------------- printers --
-- A printer is defined once, on a print server, and handed to clients by
-- policy. The PPD is optional: anything made in the last decade is driverless.
CREATE TABLE printer (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_fqdn     text NOT NULL,
    name          text NOT NULL,
    description   text NOT NULL DEFAULT '',
    location      text NOT NULL DEFAULT '',
    device_uri    text NOT NULL,
    -- The PPD itself, when one was uploaded. Empty means driverless IPP.
    ppd           text,
    ppd_name      text NOT NULL DEFAULT '',
    duplex        boolean NOT NULL DEFAULT false,
    colour        boolean NOT NULL DEFAULT true,
    shared        boolean NOT NULL DEFAULT true,
    state         text NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'applying', 'active', 'failed')),
    last_error    text,
    created_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (node_fqdn, name)
);

-- -------------------------------------------------------------------- vpn --
-- One tunnel per remote-access network. WireGuard, so a peer is a keypair and
-- an address; a client configuration is a text file it can be handed.
CREATE TABLE vpn_tunnel (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_fqdn      text NOT NULL,
    name           text NOT NULL UNIQUE,
    description    text NOT NULL DEFAULT '',
    -- What clients dial, and the port the server listens on.
    endpoint       text NOT NULL,
    listen_port    integer NOT NULL DEFAULT 51820,
    -- The tunnel's own network, and what it routes into.
    network        text NOT NULL,
    routes         text[] NOT NULL DEFAULT '{}',
    dns_servers    text[] NOT NULL DEFAULT '{}',
    search_domain  text NOT NULL DEFAULT '',
    -- The server's keypair. The private half never leaves the control plane
    -- except to the node that terminates the tunnel.
    private_key    text NOT NULL,
    public_key     text NOT NULL,
    state          text NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'applying', 'active', 'failed')),
    last_error     text,
    created_by     text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vpn_peer (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tunnel_id    uuid NOT NULL REFERENCES vpn_tunnel(id) ON DELETE CASCADE,
    name         text NOT NULL,
    -- The directory object this peer belongs to, when it is a domain computer
    -- or user rather than something hand-made.
    principal_dn text,
    address      text NOT NULL,
    private_key  text,
    public_key   text NOT NULL,
    -- A machine peer can be told to hold the tunnel up whatever the user does.
    always_on    boolean NOT NULL DEFAULT false,
    enabled      boolean NOT NULL DEFAULT true,
    created_by   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tunnel_id, name),
    UNIQUE (tunnel_id, address)
);

CREATE INDEX vpn_peer_principal_idx ON vpn_peer (lower(principal_dn));

-- --------------------------------------------------------- queued work ------
ALTER TABLE node_task DROP CONSTRAINT node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'share-apply', 'share-remove',
             'update-check', 'update-install',
             'package-install', 'package-remove',
             'policy-refresh', 'restart', 'shutdown',
             'printer-apply', 'printer-remove', 'vpn-apply')
);

-- ------------------------------------------------------------ delegation ----
INSERT INTO rbac_role (name, description, builtin) VALUES
    ('print-admin', 'Manage printers and how they are published', true),
    ('vpn-admin', 'Manage remote-access tunnels and their peers', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('print-admin', 'directory.read'),
    ('print-admin', 'server.read'),
    ('print-admin', 'printer.read'),
    ('print-admin', 'printer.write'),
    ('print-admin', 'gpo.read'),
    ('vpn-admin', 'directory.read'),
    ('vpn-admin', 'server.read'),
    ('vpn-admin', 'vpn.read'),
    ('vpn-admin', 'vpn.write'),
    ('directory-admin', 'printer.read'),
    ('directory-admin', 'dc.read'),
    ('helpdesk', 'printer.read'),
    ('backup-operator', 'dc.read'),
    ('dns-admin', 'dc.read')
ON CONFLICT DO NOTHING;
