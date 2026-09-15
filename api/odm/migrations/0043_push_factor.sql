-- A second factor approved on a phone rather than typed from it.

-- One phone per account. The topic is the secret: ntfy delivers to whoever
-- knows the topic's name, so the name is long and random and shown to the
-- person once, when they subscribe. Like a TOTP enrolment it is not finished
-- until the phone has answered, so nobody is left with a factor that reaches
-- a phone they never set up.
CREATE TABLE push_enrolment (
    principal_sid text PRIMARY KEY,
    principal     text NOT NULL,
    topic         text NOT NULL UNIQUE,
    confirmed_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One sign-in waiting on an answer. The token is what the phone sends back,
-- carried in the notification's own buttons: unguessable, single-use, and
-- worthless after a minute. What was asked (which account, which machine,
-- which way in) is kept so the answer is auditable and so a machine can only
-- read the answer to a question it asked.
CREATE TABLE push_challenge (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token         text NOT NULL UNIQUE,
    principal_sid text NOT NULL,
    principal     text NOT NULL,
    machine_dn    text NOT NULL,
    hostname      text NOT NULL,
    service       text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    decided_at    timestamptz,
    decision      text CHECK (decision IN ('approved', 'denied'))
);

CREATE INDEX push_challenge_expires_idx ON push_challenge (expires_at);

-- The button that finishes an enrolment carries a token of its own, kept on
-- the enrolment until it is tapped.
ALTER TABLE push_enrolment ADD COLUMN confirm_token text UNIQUE;
