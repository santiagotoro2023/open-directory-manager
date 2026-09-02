-- Which person a report is about, when it is about one.
--
-- A user's policy is applied in their session — drive maps, connection files,
-- the desktop background — and none of it was ever reported: the console
-- showed the effective document for a user and nothing about what happened
-- when it was applied. A drive that did not mount was visible only in the
-- machine's journal, which is not where anybody looks.
--
-- Null for a machine's own report, which is every report until now.
ALTER TABLE agent_report ADD COLUMN IF NOT EXISTS username text;

-- The console asks for one person's most recent report per machine.
CREATE INDEX IF NOT EXISTS agent_report_user_idx
    ON agent_report (lower(username), reported_at DESC)
    WHERE username IS NOT NULL;
