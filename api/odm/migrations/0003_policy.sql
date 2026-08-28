-- Group Policy objects, links and Resultant Set of Policy reporting.
--
-- ODM's settings live here rather than in SYSVOL because most of them
-- (systemd units, drive maps, sudo scope on Linux) have no native AD
-- representation. The link structure is mirrored into LDAP gPLink so real
-- GPO tooling still sees the same tree; this table is what precedence is
-- resolved from (CLAUDE.md §5.2).

ALTER TABLE gpo
    ADD COLUMN description     text NOT NULL DEFAULT '',
    ADD COLUMN settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Empty array = applies to everyone (AD's "Authenticated Users").
    ADD COLUMN security_filter jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- WMI-filter equivalent: os, hostname_pattern, security_group, ip_range.
    ADD COLUMN targeting       jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN created_by      text,
    ADD COLUMN created_at      timestamptz NOT NULL DEFAULT now();

-- What each machine last reported back after applying its policy, so RSoP is
-- observed rather than inferred (CLAUDE.md §5.2).
CREATE TABLE agent_report (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    computer_dn   text        NOT NULL,
    hostname      text        NOT NULL,
    reported_at   timestamptz NOT NULL DEFAULT now(),
    agent_version text,
    policy_serial text,
    applied_gpos  jsonb       NOT NULL DEFAULT '[]'::jsonb,
    results       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    failures      integer     NOT NULL DEFAULT 0
);

CREATE INDEX agent_report_computer_idx ON agent_report (computer_dn, reported_at DESC);
CREATE INDEX agent_report_recent_idx   ON agent_report (reported_at DESC);
