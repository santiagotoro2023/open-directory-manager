-- Whether a session may start without the profile disk, and nothing else.
--
-- The hook falls back to a local home when the disk cannot be attached, which
-- keeps a farm reachable when a file server is down. That is the right
-- trade-off for some collections and the wrong one for others: a local home
-- is a profile that exists on one host and not the others, and somebody who
-- gets one has silently stopped keeping their work where they think it is.
--
-- Off by default: a session that cannot have the profile it is supposed to
-- have does not start, and the person is told rather than given a home that
-- disappears when they land on another host.
ALTER TABLE rd_collection
    ADD COLUMN allow_local_home boolean NOT NULL DEFAULT false;
