-- Certificates may be issued from a profile the operator defined, so the
-- column that records which one can no longer be a fixed list.
--
-- ca_certificate.profile has been CHECK (profile IN ('server','client',
-- 'console')) since 0006. Issuing from a profile added in 0023 signed the
-- certificate, handed back the private key — which is shown once and never
-- stored — and then failed writing the row, so the operator got a 500 and
-- lost the key. The shape of a name is still checked; which names exist is
-- the profile table's business.

ALTER TABLE ca_certificate DROP CONSTRAINT ca_certificate_profile_check;
ALTER TABLE ca_certificate ADD CONSTRAINT ca_certificate_profile_check
    CHECK (profile ~ '^[a-z0-9][a-z0-9-]{1,30}$');
