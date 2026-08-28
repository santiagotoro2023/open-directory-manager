-- Domain backups (CLAUDE.md §4).
--
-- The archive itself is written by samba-tool; this records what was taken,
-- when, and how large, so the console can show a backup history and the
-- retention sweep knows what to remove.

CREATE TABLE domain_backup (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    path        text NOT NULL UNIQUE,
    kind        text NOT NULL DEFAULT 'online' CHECK (kind IN ('online', 'offline')),
    size_bytes  bigint NOT NULL DEFAULT 0,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    state       text NOT NULL DEFAULT 'running'
                    CHECK (state IN ('running', 'complete', 'failed', 'removed')),
    taken_by    text NOT NULL,
    detail      text
);

CREATE INDEX domain_backup_recent_idx ON domain_backup (started_at DESC);
