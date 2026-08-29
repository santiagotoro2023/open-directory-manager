-- Managing more than one machine.
--
-- Roles were only ever installed on the machine running the control plane,
-- because the installer was a local subprocess. A domain is more than its
-- controllers: a file server, a DHCP node or a CA can sit on any joined
-- member server. Work for a machine that is not this one is queued here and
-- collected by that machine's agent, which already authenticates with its
-- own Kerberos identity.

CREATE TABLE node_task (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_fqdn   text NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('role-install', 'share-apply', 'share-remove')),
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
    state       text NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'claimed', 'done', 'failed')),
    output      text,
    -- What the task is for, so the UI can show a role or a share its own state.
    subject     text,
    requested_by text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    claimed_at  timestamptz,
    finished_at timestamptz
);

-- The agent's poll is "give me my pending work", so that is the index.
CREATE INDEX node_task_pending_idx ON node_task (lower(node_fqdn), state, created_at);
CREATE INDEX node_task_subject_idx ON node_task (subject);

-- ------------------------------------------------------------- file shares --
-- ODM owns the definition; the node's agent renders it into Samba's config
-- and into POSIX ACLs. Storing it here rather than reading it back off the
-- node means a share is audited, restorable, and survives the node being
-- rebuilt from scratch.

CREATE TABLE file_share (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_fqdn   text NOT NULL,
    name        text NOT NULL,
    path        text NOT NULL,
    comment     text NOT NULL DEFAULT '',
    -- POSIX owner and owning group of the share's directory.
    owner       text NOT NULL DEFAULT 'root',
    owner_group text NOT NULL DEFAULT 'Domain Admins',
    -- [{"principal": "Engineers", "kind": "group", "access": "change", "inherit": true}]
    entries     jsonb NOT NULL DEFAULT '[]'::jsonb,
    browseable  boolean NOT NULL DEFAULT true,
    read_only   boolean NOT NULL DEFAULT false,
    state       text NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'applying', 'active', 'failed')),
    last_error  text,
    created_by  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (node_fqdn, name)
);
