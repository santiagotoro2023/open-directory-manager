-- Group membership is proven at login, but rights can be revoked mid-session.
-- Sessions carry the time of their last successful re-check so privileged
-- routes can re-prove membership periodically instead of trusting an
-- eight-hour-old decision (CLAUDE.md §6).
ALTER TABLE admin_session
    ADD COLUMN admin_verified_at timestamptz NOT NULL DEFAULT now();
