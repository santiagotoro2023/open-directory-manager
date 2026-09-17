-- Names handed out by a "Computer names" policy setting: assigned once per
-- machine and remembered, so every later policy pull says the same name.
CREATE TABLE IF NOT EXISTS hostname_assignment (
    computer_dn  TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    template     TEXT NOT NULL,
    assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    renamed_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS hostname_assignment_name ON hostname_assignment (lower(name));
