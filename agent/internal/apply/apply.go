package apply

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// StatePath records which files the last run owned. Without it, removing a
// setting from a GPO would leave the file it produced on the machine
// forever.
const StatePath = "/var/lib/odm/managed-state.json"

// And the same for the half of a policy that is resolved per person. Without
// it a user run wrote files and never pruned any, so a desktop background
// stayed on the machine after the policy object that set it was unlinked —
// which is not what a linked policy means.
const UserStatePath = "/var/lib/odm/managed-state-user.json"

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
	// Before the drive maps: where the ticket lands decides whether one can
	// be mounted at all.
	{"kerberos", applyCcache},
	{"drive_maps", applyDriveMaps},
	{"packages", applyPackages},
	{"updates", applyUpdates},
	{"trusted_certificates", applyTrustedCertificates},
	{"browser", applyBrowser},
	{"wallpaper", applyWallpaper},
	{"login_screen", applyLoginScreen},
	{"printers", applyPrinters},
	{"default_applications", applyDefaultApplications},
	{"sysctl", applySysctl},
	{"fonts", applyFonts},
	{"session", applySession},
	{"removable_storage", applyRemovableStorage},
	{"software_control", applySoftwareControl},
	{"second_factor", applySecondFactor},
	{"first_run", applyFirstRun},
	{"always_on_vpn", applyAlwaysOnVpn},
	{"local_administrator", applyLocalAdministrator},
	{"local_password_policy", applyLocalPasswordPolicy},
	{"remote_desktop_session", applyRemoteDesktopSession},
	// Last of the machine settings: it replaces this binary and schedules a
	// restart, so everything else has already been applied and reported.
	{"agent_update", applyAgentUpdate},
	{"firewall", applyFirewall},
	{"sudo_rules", applySudo},
	{"hbac_rules", applyHbacRules},
}

// userScoped are the only appliers a per-user policy may drive. A GPO linked
// where users live must not be able to mask a systemd unit or rewrite the
// firewall the moment somebody logs in.
var userScoped = map[string]bool{"drive_maps": true, "wallpaper": true, "printers": true}

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
	statePath := StatePath
	if userOnly {
		statePath = UserStatePath
	}
	// Which pass this is, so what it creates is recorded as its own and the
	// other pass does not undo it.
	env.Session = userOnly
	previous := loadState(env, statePath)
	results := []policy.Result{}

	// A managed machine gets its printers from policy, so nothing else adds
	// any. Not conditional on a printer policy existing: cups-browsed makes
	// its queues the moment CUPS starts, long before anybody logs in and a
	// user-half printer policy is resolved, and a desktop that came up with
	// two printers nobody asked for is the state this prevents.
	if !userOnly {
		results = append(results, quietBrowsing(ctx, env))
	}

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

	gone := env.Prune(previous)
	for _, removed := range gone {
		results = append(results, policy.Result{
			Setting: "removed:" + removed,
			Status:  "success",
			Reason:  "no longer in policy",
		})
	}
	results = append(results, reloadAfterPrune(ctx, gone, env)...)
	if err := saveState(env, statePath); err != nil {
		results = append(results, policy.Fail("state", err))
	}
	return results
}

// LoadState is the machine's own record of what it owns.
func LoadState(env Env) *State { return loadState(env, StatePath) }

func loadState(env Env, statePath string) *State {
	raw, err := os.ReadFile(env.Path(statePath))
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
	if state.Blocks == nil {
		state.Blocks = map[string]bool{}
	}
	return state
}

func SaveState(env Env) error { return saveState(env, StatePath) }

func saveState(env Env, statePath string) error {
	body, err := json.MarshalIndent(env.State, "", "  ")
	if err != nil {
		return err
	}
	full := env.Path(statePath)
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		return err
	}
	// Written directly rather than through WriteFile: the state file is not
	// itself policy-owned, and must not be pruned by the next run.
	return os.WriteFile(full, body, 0o600)
}

// Taking a configuration file away is a change to whatever reads it, and a
// service does not notice on its own. Removing the sshd drop-in that carried
// an HBAC deny left sshd refusing that user with a rule that no longer
// existed anywhere on disk — and nothing said so.
func reloadAfterPrune(ctx context.Context, removed []string, env Env) []policy.Result {
	type reload struct {
		prefix   string
		setting  string
		commands [][]string
	}
	reloads := []reload{
		{"/etc/ssh/sshd_config.d/", "removed:sshd", [][]string{
			{"sshd", "-t"}, {"systemctl", "reload-or-restart", "ssh"},
		}},
		{"/etc/dconf/db/", "removed:dconf", [][]string{{"dconf", "update"}}},
		{"/etc/sssd/conf.d/", "removed:sssd", [][]string{
			{"systemctl", "reload-or-restart", "sssd"},
		}},
		// The greeter's database is compiled from this directory rather than
		// read out of it, so removing the keyfile is not enough: a banner
		// stayed on the login screen after the policy that set it was gone.
		{debianGreeterDir, "removed:greeter", [][]string{{debianGreeterConfig}}},
		// A certificate a policy stops publishing has to leave the trust
		// store, and the store is a compiled bundle beside the file.
		{"/usr/local/share/ca-certificates/", "removed:trusted_certificates", [][]string{
			{"update-ca-certificates", "--fresh"},
		}},
		{"/etc/cups/", "removed:printers", [][]string{
			{"systemctl", "reload-or-restart", "cups"},
		}},
	}

	var results []policy.Result
	for _, entry := range reloads {
		wanted := false
		for _, path := range removed {
			if strings.HasPrefix(path, entry.prefix) {
				wanted = true
				break
			}
		}
		if !wanted {
			continue
		}
		results = append(results, runAll(ctx, env, entry.setting, entry.commands...))
	}
	return results
}
