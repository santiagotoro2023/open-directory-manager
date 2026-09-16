package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync/atomic"
	"time"

	"odm.example.org/agent/internal/client"
	"odm.example.org/agent/internal/config"
	"odm.example.org/agent/internal/monitor"
	"odm.example.org/agent/internal/policy"
)

// What the last policy document said about monitoring. The daemon's
// measuring loop reads it on every tick, so a role installed or removed
// takes effect at the next poll without the loop being restarted.
var monitoring atomic.Pointer[monitor.Config]

// rememberMonitoring keeps the document's monitoring block for the loop.
func rememberMonitoring(document *policy.Document) {
	var cfg monitor.Config
	if len(document.Monitoring) > 0 {
		_ = json.Unmarshal(document.Monitoring, &cfg)
	}
	monitoring.Store(&cfg)
}

// metricsLoop measures this machine on the interval the console asks for
// and runs whatever probes it was handed, for as long as the daemon runs.
// Its own client, so a report never waits behind a policy apply, and its
// own failures, which are logged once a minute at most and stop nothing.
func metricsLoop(ctx context.Context, configPath, root string) {
	var state *monitor.State
	var api *client.Client
	lastProbe := map[string]time.Time{}
	lastError := ""
	defer func() {
		if api != nil {
			api.Close()
		}
	}()
	for {
		cfg := monitoring.Load()
		interval := 60 * time.Second
		if cfg != nil && cfg.IntervalSeconds >= 10 {
			interval = time.Duration(cfg.IntervalSeconds) * time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
		if cfg == nil || !cfg.Enabled {
			state = nil
			continue
		}

		var samples []monitor.Sample
		samples, state = monitor.Collect(root, state)
		now := time.Now()
		for _, probe := range cfg.Probes {
			every := time.Duration(probe.IntervalSeconds) * time.Second
			if every < 10*time.Second {
				every = 60 * time.Second
			}
			if last, ok := lastProbe[probe.ID]; ok && now.Sub(last) < every {
				continue
			}
			lastProbe[probe.ID] = now
			samples = append(samples, monitor.RunProbe(ctx, probe)...)
		}
		if len(samples) == 0 {
			continue
		}

		if api == nil {
			loaded, err := config.Load(configPath)
			if err != nil {
				continue
			}
			if api, err = client.New(loaded, version); err != nil {
				api = nil
				continue
			}
		}
		reportCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		err := api.Metrics(reportCtx, samples)
		cancel()
		if err != nil {
			// Said once per distinct reason, not once a minute: a console
			// that is down for an hour is one line, not sixty.
			if message := err.Error(); message != lastError {
				fmt.Fprintln(os.Stderr, "odm-agent: metrics:", err)
				lastError = message
			}
			// A ticket that has gone stale is the usual reason; a fresh
			// client next time is the fix.
			api.Close()
			api = nil
			continue
		}
		lastError = ""
	}
}
