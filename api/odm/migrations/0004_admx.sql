-- Imported ADMX/ADML administrative templates (CLAUDE.md §3.6).
--
-- The vendor's own XML is the source of truth for what a setting means; ODM
-- stores the parsed definitions so the UI can render form controls and the
-- policy compiler can turn selections into settings an agent applies.

CREATE TABLE admx_template (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    namespace     text NOT NULL UNIQUE,
    prefix        text NOT NULL DEFAULT '',
    file_name     text NOT NULL,
    display_name  text NOT NULL DEFAULT '',
    revision      text NOT NULL DEFAULT '',
    policy_count  integer NOT NULL DEFAULT 0,
    has_adml      boolean NOT NULL DEFAULT false,
    uploaded_by   text NOT NULL,
    uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admx_category (
    template_id   uuid NOT NULL REFERENCES admx_template (id) ON DELETE CASCADE,
    name          text NOT NULL,
    display_name  text NOT NULL DEFAULT '',
    parent        text,
    PRIMARY KEY (template_id, name)
);

CREATE TABLE admx_policy (
    id             text PRIMARY KEY,          -- namespace:policyName
    template_id    uuid NOT NULL REFERENCES admx_template (id) ON DELETE CASCADE,
    name           text NOT NULL,
    display_name   text NOT NULL,
    explain_text   text NOT NULL DEFAULT '',
    policy_class   text NOT NULL DEFAULT 'Both',
    category       text NOT NULL DEFAULT '',
    registry_key   text NOT NULL DEFAULT '',
    value_name     text NOT NULL DEFAULT '',
    supported_on   text NOT NULL DEFAULT '',
    enabled_value  jsonb,
    disabled_value jsonb,
    elements       jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Whether ODM can turn this policy into something a Debian client obeys.
    applicable     boolean NOT NULL DEFAULT false
);

CREATE INDEX admx_policy_template_idx ON admx_policy (template_id);
CREATE INDEX admx_policy_category_idx ON admx_policy (category);
CREATE INDEX admx_policy_search_idx   ON admx_policy (lower(display_name));
