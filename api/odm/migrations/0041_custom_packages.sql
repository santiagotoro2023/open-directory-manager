-- A .deb an operator uploads directly, for software with no apt repository
-- this domain can reach. The policy object only ever carries this row's id —
-- the file itself lives on the control plane's own disk, under
-- custom_package_dir, because a policy document is fetched by every machine
-- it reaches on every poll and a software package is routinely tens of
-- megabytes, which nothing else a policy object carries inline ever is.
CREATE TABLE IF NOT EXISTS custom_package (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The label an operator gave it, shown in the console and in a policy
    -- object. Not necessarily the real package name.
    name          text NOT NULL,
    file_name     text NOT NULL,
    -- What dpkg-deb actually found inside it, read once at upload time so
    -- the agent knows what to remove later without needing the file again.
    package_name  text NOT NULL,
    version       text NOT NULL DEFAULT '',
    architecture  text NOT NULL DEFAULT '',
    size_bytes    bigint NOT NULL,
    sha256        text NOT NULL,
    uploaded_by   text NOT NULL DEFAULT '',
    uploaded_at   timestamptz NOT NULL DEFAULT now()
);

-- Uploading and removing one is gated the same way as everything else a
-- policy object can already do — gpo.write and gpo.read, not a permission of
-- its own: a policy object can already deploy an arbitrary script or file to
-- every machine it reaches, and a package is not a wider door than that.
