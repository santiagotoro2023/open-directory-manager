package apply

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"odm.example.org/agent/internal/policy"
)

// StatePath records which files the last run owned. Without it, removing a
// setting from a GPO would leave the file it produced on the machine
// forever.
const StatePath = "/var/lib/odm/managed-state.json"

type applier struct {
	name string
	run  func(context.Context, policy.Settings, Env) []policy.Result
}

// Order matters: files and units are written before anything is asked to
// reload, and access control is applied last so a broken earlier step cannot
// leave a half-open machine.
var appliers = []applier{
	{"files", applyFiles},
	{"scripts", applyScripts},
	{"systemd_units", applySystemdUnits},
	{"cron", applyCron},
	{"drive_maps", applyDriveMaps},
	{"browser", applyBrowser},
	{"wallpaper", applyWallpaper},
	{"firewall", applyFirewall},
	{"sudo_rules", applySudo},
	{"hbac_rules", applyHbacRules},
}

// userScoped are the only appliers a per-user policy may drive. A GPO linked
// where users live must not be able to mask a systemd unit or rewrite the
// firewall the moment somebody logs in.
var userScoped = map[string]bool{"drive_maps": true, "wallpaper": true}

// Apply runs every applier over one resolved policy document and returns the
// Resultant Set of Policy. It never aborts on the first failure: a broken
// setting must not stop the rest of the policy from being applied.
func Apply(ctx context.Context, settings policy.Settings, env Env) []policy.Result {
	return run(ctx, settings, env, false)
}

// ApplyUser applies the policy resolved for one logging-on user. It shares
// no state file with the machine run, so it never prunes machine policy.
func ApplyUser(ctx context.Context, settings policy.Settings, env Env) []policy.Result {
	return run(ctx, settings, env, true)
}

func run(ctx context.Context, settings policy.Settings, env Env, userOnly bool) []policy.Result {
	var previous *State
	if !userOnly {
		previous = LoadState(env)
	}
	results := []policy.Result{}

	for _, item := range appliers {
		if userOnly && !userScoped[item.name] {
			continue
		}
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					results = append(results, policy.Result{
						Setting: item.name,
						Status:  "failed",
						Reason:  "applier panicked",
					})
				}
			}()
			results = append(results, item.run(ctx, settings, env)...)
		}()
	}

	if userOnly {
		return results
	}
	for _, removed := range env.Prune(previous) {
		results = append(results, policy.Result{
			Setting: "removed:" + removed,
			Status:  "success",
			Reason:  "no longer in policy",
		})
	}
	if err := SaveState(env); err != nil {
		results = append(results, policy.Fail("state", err))
	}
	return results
}

func LoadState(env Env) *State {
	raw, err := os.ReadFile(env.Path(StatePath))
	if err != nil {
		return NewState()
	}
	state := NewState()
	if err := json.Unmarshal(raw, state); err != nil {
		return NewState()
	}
	if state.Owned == nil {
		state.Owned = map[string]bool{}
	}
	return state
}

func SaveState(env Env) error {
	body, err := json.MarshalIndent(env.State, "", "  ")
	if err != nil {
		return err
	}
	full := env.Path(StatePath)
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		return err
	}
	// Written directly rather than through WriteFile: the state file is not
	// itself policy-owned, and must not be pruned by the next run.
	return os.WriteFile(full, body, 0o600)
}
