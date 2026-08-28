-- Certificate authority (CLAUDE.md §4).
--
-- Private keys are handed to the requester once and never stored; what is
-- kept here is the issued certificate and enough metadata to build a
-- revocation list and show an inventory.

CREATE TABLE ca_certificate (
    serial          text PRIMARY KEY,
    subject         text NOT NULL,
    sans            jsonb NOT NULL DEFAULT '[]'::jsonb,
    profile         text NOT NULL CHECK (profile IN ('server', 'client', 'console')),
    certificate_pem text NOT NULL,
    fingerprint     text NOT NULL,
    not_before      timestamptz NOT NULL,
    not_after       timestamptz NOT NULL,
    issued_by       text NOT NULL,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    revoked_by      text,
    revocation_reason text
);

CREATE INDEX ca_certificate_subject_idx ON ca_certificate (lower(subject));
CREATE INDEX ca_certificate_expiry_idx  ON ca_certificate (not_after);
