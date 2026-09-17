-- The console as the domain's OpenID Connect provider: one signing key,
-- the clients the console registers itself, and the short-lived codes and
-- tokens of the authorization-code flow. The password manager is the first
-- client; its sign-in is switched on and off from its own row.
CREATE TABLE IF NOT EXISTS oidc_key (
    id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    kid         text NOT NULL,
    private_pem text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oidc_client (
    client_id     text PRIMARY KEY,
    name          text NOT NULL,
    secret_hash   text NOT NULL,
    redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oidc_code (
    code           text PRIMARY KEY,
    client_id      text NOT NULL REFERENCES oidc_client (client_id) ON DELETE CASCADE,
    redirect_uri   text NOT NULL,
    nonce          text NOT NULL DEFAULT '',
    code_challenge text NOT NULL DEFAULT '',
    claims         jsonb NOT NULL,
    expires_at     timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS oidc_token (
    token      text PRIMARY KEY,
    kind       text NOT NULL CHECK (kind IN ('access', 'refresh')),
    client_id  text NOT NULL REFERENCES oidc_client (client_id) ON DELETE CASCADE,
    claims     jsonb NOT NULL,
    nonce      text NOT NULL DEFAULT '',
    scope      text NOT NULL DEFAULT '',
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oidc_token_expires ON oidc_token (expires_at);

ALTER TABLE password_manager
    ADD COLUMN IF NOT EXISTS sso_enabled       boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS sso_only          boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS sso_client_id     text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS sso_client_secret text NOT NULL DEFAULT '';
