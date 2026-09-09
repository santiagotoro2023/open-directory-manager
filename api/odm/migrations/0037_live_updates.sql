-- The console reloads itself when something changes, so an operator watching
-- a role install, a share being created or a machine reporting does not have
-- to press refresh to find out whether it happened.
--
-- One notification channel, one payload: the table that changed. The console
-- re-reads with the rights of whoever is looking, so nothing about the change
-- itself travels here.
--
-- Per row, not per statement: a statement-level trigger fires whether or not
-- the statement matched anything, and an agent asking for work runs an UPDATE
-- that usually matches nothing — a fleet of machines polling would be a
-- steady stream of "something changed" over a table where nothing had.
CREATE OR REPLACE FUNCTION odm_notify() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('odm_changed', TG_TABLE_NAME);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    watched text;
BEGIN
    FOREACH watched IN ARRAY ARRAY[
        'audit_log', 'node_task', 'server_role', 'rd_collection', 'rd_host',
        'share', 'printer', 'gpo', 'gpo_link', 'computer_fact', 'agent_report',
        'vpn_peer', 'certificate', 'deleted_object', 'rbac_assignment',
        'totp_enrolment', 'password_policy', 'dhcp_scope'
    ]
    LOOP
        IF to_regclass(watched) IS NOT NULL THEN
            EXECUTE format(
                'DROP TRIGGER IF EXISTS odm_notify_changed ON %I;
                 CREATE TRIGGER odm_notify_changed
                 AFTER INSERT OR UPDATE OR DELETE ON %I
                 FOR EACH ROW EXECUTE FUNCTION odm_notify()', watched, watched);
        END IF;
    END LOOP;
END;
$$;
