-- The local administrator each machine manages for itself.
--
-- Active Directory calls this LAPS. The machine generates the password,
-- rotates it on a schedule and reports it here; an administrator reads it off
-- the computer object when the domain is unreachable from that machine. One
-- row per computer, replaced on every rotation — the previous password is of
-- no use once the new one is set, and keeping it would only widen what a copy
-- of this table gives away.
CREATE TABLE local_administrator (
    computer_dn  text PRIMARY KEY,
    account      text        NOT NULL,
    password     text        NOT NULL,
    rotated_at   timestamptz NOT NULL,
    expires_at   timestamptz NOT NULL,
    reported_at  timestamptz NOT NULL DEFAULT now()
);

-- Reading one is a privileged act, audited like any other, so it is its own
-- permission rather than something that comes with reading a computer.
INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('domain-admin', 'computer.localadmin.read')
ON CONFLICT DO NOTHING;
