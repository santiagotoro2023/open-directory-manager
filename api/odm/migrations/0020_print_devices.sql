-- What CUPS can see from a print server, reported with the rest of its
-- inventory. Choosing a printer's address in the console was typing a URI
-- from memory; this is the list the server itself found.
ALTER TABLE computer_fact
    ADD COLUMN print_devices jsonb NOT NULL DEFAULT '[]'::jsonb;
