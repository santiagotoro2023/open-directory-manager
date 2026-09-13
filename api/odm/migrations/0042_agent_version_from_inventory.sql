-- What version of itself the agent is actually running, reported the same
-- way everything else in computer_fact is: on every pass, not only the ones
-- that also change what a machine applies.
--
-- The console used to read this off the latest agent_report row instead, and
-- agent_report gets a row only when a policy apply actually ran something —
-- which a machine whose policy has not changed in weeks does not do, however
-- many times its own binary has been replaced since. An agent that had in
-- fact updated itself hours ago, and a console still showing the version
-- from before that, were the same bug reporting.py already fixed once for
-- second-factor enrolments; this is the same fix for the version number.
ALTER TABLE computer_fact
    ADD COLUMN IF NOT EXISTS agent_version text NOT NULL DEFAULT '';
