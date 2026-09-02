-- Replication state, as the controller it belongs to reports it.
--
-- Samba refuses DsReplicaGetInfo — the call behind `samba-tool drs showrepl` —
-- to any caller below domain-controller level, whatever access-control entries
-- it holds, so the control plane's own account can never read it: the console
-- showed "the account does not hold the replication rights" and pointed at a
-- script that could not have granted them. A controller's machine account does
-- hold that level, and root on that controller is the agent, so each controller
-- collects its own state with its inventory and this is where it lands.
ALTER TABLE computer_fact
    ADD COLUMN IF NOT EXISTS replication    text,
    ADD COLUMN IF NOT EXISTS replication_at timestamptz;
