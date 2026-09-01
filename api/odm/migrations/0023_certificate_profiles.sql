-- Certificate profiles beyond the two built in, the way AD CS has templates
-- beyond Web Server and User: an operator issuing for a mail gateway or a
-- code-signing key should not have to be told "server or client".
--
-- Only the shape of a certificate lives here. The key and the signature are
-- still made by ca.py from the domain authority (CLAUDE.md §6).

CREATE TABLE IF NOT EXISTS certificate_profile (
    name          text PRIMARY KEY
                  CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,30}$'),
    description   text NOT NULL DEFAULT '',
    purposes      text[] NOT NULL CHECK (cardinality(purposes) BETWEEN 1 AND 8),
    validity_days integer NOT NULL CHECK (validity_days BETWEEN 1 AND 1825),
    key_size      integer NOT NULL DEFAULT 2048
                  CHECK (key_size IN (2048, 3072, 4096)),
    created_by    text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
