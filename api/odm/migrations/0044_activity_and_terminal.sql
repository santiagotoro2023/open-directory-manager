-- What people did on the machines, and a terminal to them.

-- computer_event used to hold what wtmp knows: who logged on, when it
-- booted. It now holds what the machine's journal knows — a sudo command, a
-- switch to root, a refused password, a second factor approved on a phone,
-- a password changed, a local account added, a USB stick plugged in — each
-- as one row of the same shape, so the question "what did this person do,
-- on which machines, this week" is one query over one table. The kinds are
-- no longer a closed list here: the agent that reads the journal is what
-- knows them, and a new one must not be refused by a constraint written
-- before it existed. The control plane still validates what it accepts.
ALTER TABLE computer_event DROP CONSTRAINT IF EXISTS computer_event_kind_check;
ALTER TABLE computer_event
    ADD COLUMN IF NOT EXISTS service text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS source  text NOT NULL DEFAULT '';

-- The fleet-wide questions: everything this week, everything this person
-- did, every sudo command anywhere.
CREATE INDEX IF NOT EXISTS computer_event_when_idx      ON computer_event (occurred_at DESC);
CREATE INDEX IF NOT EXISTS computer_event_principal_idx ON computer_event (lower(principal), occurred_at DESC);
CREATE INDEX IF NOT EXISTS computer_event_kind_idx      ON computer_event (kind, occurred_at DESC);

-- A terminal on a machine is a new kind of queued work: the task only asks
-- the agent to open the connection, and the session itself runs over it.
ALTER TABLE node_task DROP CONSTRAINT IF EXISTS node_task_kind_check;
ALTER TABLE node_task ADD CONSTRAINT node_task_kind_check CHECK (
    kind IN ('role-install', 'console-certificate',
             'share-apply', 'share-remove',
             'update-check', 'update-install',
             'package-install', 'package-remove',
             'browse', 'make-directory', 'set-permissions', 'printer-discover',
             'printer-apply', 'printer-remove', 'printer-test', 'vpn-apply',
             'radius-apply', 'rd-host-apply', 'rd-broker-apply',
             'rd-profile-list', 'rd-profile-manage',
             'domain-backup', 'local-user-add', 'local-user-remove',
             'policy-refresh', 'restart', 'shutdown',
             'agent-update', 'shell-run', 'disk-escrow', 'remote-assist',
             'shell-session')
);
