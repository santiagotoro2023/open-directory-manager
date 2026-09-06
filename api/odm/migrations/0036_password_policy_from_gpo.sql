-- The domain's password policy is a policy-object setting, like everything
-- else an operator sets. Fine-grained policies are written from the policy
-- object that carries them, and this is the link back to it: a password
-- settings object ODM created from a policy object goes when that policy
-- object stops asking for it, and one an operator created themselves — no
-- source — is left exactly where it is.
ALTER TABLE password_policy
    ADD COLUMN IF NOT EXISTS source_gpo uuid REFERENCES gpo (guid) ON DELETE SET NULL;

-- Setting the password policy is now writing a policy object, so the right to
-- do it is the right to write one. Nothing is taken away: every role that
-- could set a password policy is a role that can write policy objects.
DELETE FROM rbac_role_permission WHERE permission = 'password.policy.write';
