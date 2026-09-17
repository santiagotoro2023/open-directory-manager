-- The password manager, managed from the console: the console's own
-- service account owns the vault's organisation, and what the console
-- decides — who has a seat, which collections exist, which groups see
-- which — is kept here and reconciled into the vault. The directory
-- connector, its account and the organisation API key are gone with it.
ALTER TABLE password_manager
    ADD COLUMN IF NOT EXISTS owner_account   text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS owner_password  text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS org_id          text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS org_key         text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS org_name        text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS seat_users      jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS members         jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS last_sync_at    timestamptz,
    ADD COLUMN IF NOT EXISTS last_sync_result text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS sync_requested  boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS vault_collection (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    vault_id    text NOT NULL DEFAULT '',
    created_by  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (name)
);

-- Which domain group sees a collection, and whether it may change it.
CREATE TABLE IF NOT EXISTS vault_collection_access (
    collection_id uuid NOT NULL REFERENCES vault_collection (id) ON DELETE CASCADE,
    group_name    text NOT NULL,
    read_only     boolean NOT NULL DEFAULT false,
    PRIMARY KEY (collection_id, group_name)
);
