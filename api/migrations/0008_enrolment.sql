-- One-time enrolment tokens (CLAUDE.md §5.6).
--
-- A token lets a machine enrol without a domain administrator credential
-- ever reaching it. Only the token's hash is stored, so the table cannot be
-- read to obtain a usable token.

CREATE TABLE join_token (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_sha256  text NOT NULL UNIQUE,
    label         text NOT NULL DEFAULT '',
    -- Where the host account is created.
    container_dn  text NOT NULL,
    -- Optional: restrict the token to one host name.
    hostname      text,
    uses_allowed  integer NOT NULL DEFAULT 1 CHECK (uses_allowed BETWEEN 1 AND 1000),
    uses_spent    integer NOT NULL DEFAULT 0,
    expires_at    timestamptz NOT NULL,
    created_by    text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz,
    last_used_at  timestamptz,
    last_used_by  text
);

CREATE INDEX join_token_expiry_idx ON join_token (expires_at);
