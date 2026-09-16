-- A probe reports under one series per kind of check, so a TCP probe and an
-- HTTP probe of the same target do not overwrite each other: probe_up:ping,
-- probe_up:tcp-8443, probe_up:http. The seeded rule watches the family.
UPDATE monitor_rule SET metric = 'probe_up:' WHERE metric = 'probe_up';
DELETE FROM metric_sample WHERE metric IN ('probe_up', 'probe_latency_ms');
