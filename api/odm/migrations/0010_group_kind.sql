-- What a group is for: users, or computers.
--
-- The directory has no attribute for this, so it is recorded here against
-- the group's security identifier, which survives a rename or a move. A
-- group ODM has never classified reads as a user group.

CREATE TABLE group_kind (
    object_sid text PRIMARY KEY,
    kind       text NOT NULL CHECK (kind IN ('user', 'computer')),
    group_dn   text NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX group_kind_dn_idx ON group_kind (group_dn);
