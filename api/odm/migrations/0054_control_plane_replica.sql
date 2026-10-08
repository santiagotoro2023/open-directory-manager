-- Where each replica of the control plane can be reached by the others,
-- when more than one runs against this database (replicas.py). A terminal or
-- a shared screen lives in one replica's memory and carries that replica's
-- number in its id; a socket that lands on another replica is carried across
-- to the address recorded here.
CREATE TABLE IF NOT EXISTS control_plane_replica (
    id       serial PRIMARY KEY,
    url      text NOT NULL UNIQUE,
    seen_at  timestamptz NOT NULL DEFAULT now()
);
