-- The monitoring role: what the machines measure, what is watched, who is
-- told, and the dashboards it is looked at through.

-- One number about one host at one moment. Every agent sends a handful a
-- minute once the role exists; the probes a monitoring server runs land
-- here too, with the probe's target as the host. Kept for a fortnight and
-- swept by the control plane, so this stays a working set and not an archive
-- — a longer memory belongs to something built for time series.
CREATE TABLE metric_sample (
    host   text             NOT NULL,
    metric text             NOT NULL,
    value  double precision NOT NULL,
    at     timestamptz      NOT NULL DEFAULT now()
);
CREATE INDEX metric_sample_series_idx ON metric_sample (host, metric, at DESC);
CREATE INDEX metric_sample_at_idx     ON metric_sample (at);

-- Hosts an operator thinks of together: "the file servers", "the lab".
-- Membership is by name, which is what a machine reports itself as.
CREATE TABLE monitor_group (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL UNIQUE,
    description text NOT NULL DEFAULT '',
    members     text[] NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Something a monitoring server checks from the outside: a switch that
-- answers ping, a printer's port, a web page. Run by every node carrying the
-- role, on the interval given.
CREATE TABLE monitor_probe (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name             text NOT NULL UNIQUE,
    kind             text NOT NULL CHECK (kind IN ('ping', 'tcp', 'http')),
    target           text NOT NULL,
    port             integer NOT NULL DEFAULT 0 CHECK (port BETWEEN 0 AND 65535),
    interval_seconds integer NOT NULL DEFAULT 60 CHECK (interval_seconds BETWEEN 10 AND 3600),
    enabled          boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- Where an alert goes. ntfy is the one the phone app already subscribes to
-- — a topic of its own, with a code to scan — and a webhook is for whatever
-- else listens for JSON.
CREATE TABLE monitor_channel (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text NOT NULL UNIQUE,
    kind         text NOT NULL CHECK (kind IN ('ntfy', 'webhook')),
    topic        text NOT NULL DEFAULT '',
    url          text NOT NULL DEFAULT '',
    min_severity text NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('warning', 'critical')),
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- A condition on a metric, over a scope, for long enough, at a severity.
-- The scope is every host, a group, or one host. A metric name ending in ':'
-- matches every series with that prefix — disk_percent: is every mounted
-- filesystem — and each series alerts on its own.
CREATE TABLE monitor_rule (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL UNIQUE,
    description text NOT NULL DEFAULT '',
    metric      text NOT NULL,
    op          text NOT NULL CHECK (op IN ('gt', 'lt')),
    threshold   double precision NOT NULL,
    for_seconds integer NOT NULL DEFAULT 300 CHECK (for_seconds BETWEEN 0 AND 86400),
    severity    text NOT NULL DEFAULT 'warning' CHECK (severity IN ('warning', 'critical')),
    scope_kind  text NOT NULL DEFAULT 'all' CHECK (scope_kind IN ('all', 'group', 'host')),
    scope       text NOT NULL DEFAULT '',
    channels    uuid[] NOT NULL DEFAULT '{}',
    enabled     boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One rule firing for one series on one host: opened when the condition has
-- held for long enough, resolved when it stops. Suppressed says it fired
-- inside a maintenance window and nobody was told.
CREATE TABLE monitor_alert (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id     uuid REFERENCES monitor_rule (id) ON DELETE CASCADE,
    rule_name   text NOT NULL,
    host        text NOT NULL,
    metric      text NOT NULL,
    severity    text NOT NULL,
    state       text NOT NULL DEFAULT 'firing' CHECK (state IN ('firing', 'resolved')),
    last_value  double precision,
    message     text NOT NULL DEFAULT '',
    suppressed  boolean NOT NULL DEFAULT false,
    started_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    notified_at timestamptz
);
CREATE INDEX monitor_alert_open_idx   ON monitor_alert (state, started_at DESC);
CREATE INDEX monitor_alert_series_idx ON monitor_alert (rule_id, host, metric, state);

-- A window in which alerts for a scope are recorded but nobody is told:
-- planned work is not an incident.
CREATE TABLE monitor_maintenance (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    scope_kind text NOT NULL DEFAULT 'all' CHECK (scope_kind IN ('all', 'group', 'host')),
    scope      text NOT NULL DEFAULT '',
    starts_at  timestamptz NOT NULL,
    ends_at    timestamptz NOT NULL,
    note       text NOT NULL DEFAULT '',
    created_by text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);

-- A dashboard is a layout: widgets, each naming what it shows. A public
-- token makes it readable at a URL without a session — for a screen on a
-- wall — and is as long as a session token; revoking it is clearing it.
CREATE TABLE monitor_dashboard (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text NOT NULL UNIQUE,
    layout       jsonb NOT NULL DEFAULT '{"widgets": []}'::jsonb,
    is_default   boolean NOT NULL DEFAULT false,
    channel_id   uuid REFERENCES monitor_channel (id) ON DELETE SET NULL,
    public_token text UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- What every domain wants watched from the first minute. Editable and
-- deletable like anything else; seeded so the role is useful before anyone
-- has written a rule.
INSERT INTO monitor_rule (name, description, metric, op, threshold, for_seconds, severity) VALUES
    ('Machine not reporting', 'No metrics from the machine for five minutes.',
     'agent_up', 'lt', 1, 300, 'critical'),
    ('Filesystem almost full', 'A mounted filesystem over 90% used.',
     'disk_percent:', 'gt', 90, 300, 'critical'),
    ('Filesystem filling up', 'A mounted filesystem over 80% used.',
     'disk_percent:', 'gt', 80, 900, 'warning'),
    ('Memory exhausted', 'Memory over 95% used for five minutes.',
     'mem_percent', 'gt', 95, 300, 'warning'),
    ('Processor saturated', 'Processor over 95% busy for fifteen minutes.',
     'cpu_percent', 'gt', 95, 900, 'warning'),
    ('Running hot', 'The hottest sensor over 85 °C.',
     'temp_c', 'gt', 85, 120, 'critical'),
    ('Probe failing', 'A probe target not answering for three minutes.',
     'probe_up', 'lt', 1, 180, 'critical')
ON CONFLICT (name) DO NOTHING;

INSERT INTO monitor_dashboard (name, layout, is_default) VALUES (
    'Overview',
    '{"widgets": [
        {"id": "w1", "type": "hosts", "title": "Machines", "w": 6, "h": 2},
        {"id": "w2", "type": "alerts", "title": "Open alerts", "w": 6, "h": 2},
        {"id": "w3", "type": "chart", "title": "Processor", "metric": "cpu_percent", "scope_kind": "all", "scope": "", "hours": 6, "w": 6, "h": 2},
        {"id": "w4", "type": "chart", "title": "Memory", "metric": "mem_percent", "scope_kind": "all", "scope": "", "hours": 6, "w": 6, "h": 2},
        {"id": "w5", "type": "chart", "title": "Root filesystem", "metric": "disk_percent:/", "scope_kind": "all", "scope": "", "hours": 24, "w": 6, "h": 2},
        {"id": "w6", "type": "chart", "title": "Temperature", "metric": "temp_c", "scope_kind": "all", "scope": "", "hours": 6, "w": 6, "h": 2}
    ]}'::jsonb,
    true
) ON CONFLICT (name) DO NOTHING;

INSERT INTO rbac_role_permission (role_name, permission) VALUES
    ('domain-admin', 'monitor.read'),
    ('domain-admin', 'monitor.write'),
    ('auditor', 'monitor.read'),
    ('helpdesk', 'monitor.read')
ON CONFLICT DO NOTHING;

-- A monitoring server's own probes are a new kind of queued work only in the
-- sense that the agent asks for them; nothing is queued. The role installs
-- through the ordinary role-install task.
