-- Certificates the domain trusts, beyond ODM's own root.
--
-- A domain trusts more than one authority in practice: an existing internal
-- CA that predates ODM, a vendor's appliance certificate, the CA in front of
-- an internal service. Each of them has to reach every machine's trust store,
-- and the mechanism for that already exists — the trusted_certificates policy
-- setting. What was missing was somewhere to keep them and one place to
-- publish them all from.

CREATE TABLE trust_anchor (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL UNIQUE,
    description text NOT NULL DEFAULT '',
    certificate_pem text NOT NULL,
    -- Read out of the certificate at upload, so the console can show what a
    -- blob of base64 actually is without parsing it again on every page load.
    subject     text NOT NULL DEFAULT '',
    issuer      text NOT NULL DEFAULT '',
    fingerprint text NOT NULL DEFAULT '',
    not_before  timestamptz,
    not_after   timestamptz,
    is_ca       boolean NOT NULL DEFAULT false,
    added_by    text,
    added_at    timestamptz NOT NULL DEFAULT now()
);
