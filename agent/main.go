// Command odm-agent applies the effective policy the ODM control plane
// resolves for this machine, and reports the Resultant Set of Policy back.
//
// The agent holds no precedence logic of its own: inheritance, link order,
// enforcement, security filtering and item-level targeting are resolved once,
// server-side, and this binary applies the flattened result (CLAUDE.md §5.2).
package main

import (
	"context"
	"crypto/rand"
	"flag"
	"fmt"
	"math/big"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"odm.example.org/agent/internal/apply"
	"odm.example.org/agent/internal/client"
	"odm.example.org/agent/internal/config"
	"odm.example.org/agent/internal/enrol"
	"odm.example.org/agent/internal/inventory"
	"odm.example.org/agent/internal/policy"
	"odm.example.org/agent/internal/tasks"
)

const version = "0.8.0"

const serialPath = "/var/lib/odm/last-serial"

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	// Started from PAM there is no environment at all, and the appliers run
	// mount, getent and systemctl by name.
	if os.Getenv("PATH") == "" {
		_ = os.Setenv("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	}

	switch os.Args[1] {
	case "apply":
		os.Exit(runApply(os.Args[2:]))
	case "daemon":
		os.Exit(runDaemon(os.Args[2:]))
	case "profile":
		os.Exit(runProfile(os.Args[2:]))
	case "--version", "-v", "version":
		fmt.Println("odm-agent", version)
	default:
		usage()
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `usage: odm-agent <command> [flags]

  apply [--force] [--user NAME]   fetch and apply policy now
  daemon                          apply on the policy's refresh interval
  profile --user NAME [--release] attach that person's roaming profile
  --version                       print the version

  --force is the equivalent of gpupdate /force: apply even when the policy
  has not changed since the last run.
`)
	os.Exit(2)
}

func runApply(args []string) int {
	flags := flag.NewFlagSet("apply", flag.ExitOnError)
	configPath := flags.String("config", config.DefaultPath, "agent configuration file")
	root := flags.String("root", "", "write beneath this directory instead of /")
	username := flags.String("user", "", "apply the policy for this user instead of the machine")
	force := flags.Bool("force", false, "apply even if the policy has not changed")
	_ = flags.Parse(args)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := applyOnce(ctx, *configPath, *root, *username, *force); err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent:", err)
		return 1
	}
	return 0
}

// runProfile attaches a roaming profile, and is run from PAM before the
// session starts rather than from the ordinary apply loop: a home directory
// has to be in place before anything opens a file in it.
//
// Every failure is reported and none of them is fatal. A profile share that
// cannot be reached must leave somebody with a local home for that session,
// never with no way to sign in.
func runProfile(args []string) int {
	flags := flag.NewFlagSet("profile", flag.ExitOnError)
	configPath := flags.String("config", config.DefaultPath, "agent configuration file")
	root := flags.String("root", "", "write beneath this directory instead of /")
	username := flags.String("user", "", "the person signing in")
	release := flags.Bool("release", false, "detach at the end of the session")
	_ = flags.Parse(args)
	// PAM hands over whatever the person typed at the greeter, and the greeter
	// suggests DOMAIN\name. The directory is asked about the account.
	name := *username
	if _, rest, found := strings.Cut(name, `\`); found {
		name = rest
	}
	name, _, _ = strings.Cut(name, "@")
	if name == "" {
		return 0
	}
	username = &name

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	env := apply.NewEnv(*root)

	if *release {
		apply.ReleaseProfile(ctx, *username, env)
		return 0
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent: roaming profile:", err)
		return 0
	}
	api, err := client.New(cfg, version)
	if err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent: roaming profile:", err)
		return 0
	}
	defer api.Close()

	document, err := api.UserPolicy(ctx, *username)
	if err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent: roaming profile:", err)
		return 0
	}
	if err := apply.MountProfile(ctx, document.Settings.RoamingProfile, *username, env); err != nil {
		fmt.Fprintf(os.Stderr,
			"odm-agent: %s keeps a local home this session: %v\n", *username, err)
	}
	// Drive maps come with the profile, and for the same reason: they are
	// mounted with this person's ticket, which only exists inside their
	// session.
	problems := apply.MountDriveMaps(ctx, document.Settings.DriveMaps, *username, env)
	for _, problem := range problems {
		fmt.Fprintln(os.Stderr, "odm-agent: drive map:", problem)
	}
	if err := apply.ApplyPhoto(document.User.Photo, *username, env); err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent: picture:", err)
	}
	// Said either way, so a login that produced no drive says so rather than
	// saying nothing at all.
	fmt.Printf("%d drive map(s) for %s, %d problem(s)\n",
		len(document.Settings.DriveMaps), *username, len(problems))
	return 0
}

func runDaemon(args []string) int {
	flags := flag.NewFlagSet("daemon", flag.ExitOnError)
	configPath := flags.String("config", config.DefaultPath, "agent configuration file")
	root := flags.String("root", "", "write beneath this directory instead of /")
	_ = flags.Parse(args)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Set by a policy-refresh task arriving while the agent is waiting: the
	// next pass through the loop applies whether or not the policy changed,
	// which is what somebody clicking Refresh in the console asked for.
	forced := false
	for {
		wait := 15 * time.Minute
		if err := applyOnce(ctx, *configPath, *root, "", forced); err != nil {
			fmt.Fprintln(os.Stderr, "odm-agent:", err)
		} else if cfg, err := config.Load(*configPath); err == nil && cfg.RefreshMinutes > 0 {
			wait = time.Duration(cfg.RefreshMinutes) * time.Minute
		}

		keepGoing, refresh := waitAndPoll(ctx, *configPath, *root, wait+jitter(wait))
		if !keepGoing {
			return 0
		}
		forced = refresh
	}
}

// waitAndPoll waits until the next policy refresh, collecting queued work as
// it is queued. Returns false when the agent should stop.
//
// Policy is compared against a serial and applied only when it changes; a task
// is somebody in the console waiting for an answer. Making them share a
// fifteen-minute interval meant clicking Install and watching "installing" for
// a quarter of an hour with no way to tell it apart from a failure.
//
// The control plane holds the request open until there is work or taskWait
// passes, so an action runs within a second of being clicked rather than at
// the next poll. Idle traffic is the same one request per machine either way.
const taskWait = 25 * time.Second

// Returns whether the agent should keep going, and whether a policy refresh
// was asked for while it waited.
func waitAndPoll(
	ctx context.Context, configPath, root string, remaining time.Duration,
) (bool, bool) {
	// One Kerberos client for the whole window rather than one per poll: a
	// ticket is good for hours, and asking the KDC for a new one every half
	// minute on every machine in the domain is real load for nothing.
	var api *client.Client
	defer func() {
		if api != nil {
			api.Close()
		}
	}()

	for remaining > 0 {
		if ctx.Err() != nil {
			return false, false
		}
		if api == nil {
			cfg, err := config.Load(configPath)
			if err == nil {
				// A failure here is not worth a log line every half minute;
				// the next policy refresh reports it properly.
				if api, err = client.New(cfg, version); err != nil {
					api = nil
				}
			}
		}

		step := taskWait
		if remaining < step {
			step = remaining
		}
		started := time.Now()
		if api == nil {
			// Nothing to ask. Wait out the step rather than spinning.
			select {
			case <-ctx.Done():
				return false, false
			case <-time.After(step):
			}
		} else {
			queued, err := api.WaitForTasks(ctx, step)
			if err != nil {
				api = nil
				// An error comes back immediately, so without this the loop
				// would spin against an unreachable control plane.
				select {
				case <-ctx.Done():
					return false, false
				case <-time.After(step):
				}
			} else if len(queued) > 0 {
				// A refresh ends the wait rather than being noted and
				// forgotten: the point of asking for one is not waiting a
				// quarter of an hour for it.
				if runQueued(ctx, api, apply.NewEnv(root), queued) {
					return true, true
				}
			}
		}
		remaining -= time.Since(started)
	}
	return true, false
}

func applyOnce(ctx context.Context, configPath, root, username string, force bool) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	api, err := client.New(cfg, version)
	if err != nil {
		return err
	}
	defer api.Close()

	var document *policy.Document
	if username != "" {
		document, err = api.UserPolicy(ctx, username)
	} else {
		document, err = api.Policy(ctx)
	}
	if err != nil {
		return err
	}

	env := apply.NewEnv(root)
	if !force && username == "" && document.Serial == lastSerial(env) {
		fmt.Println("policy unchanged")
		runTasks(ctx, api, env)
		reportInventory(ctx, api, env)
		return nil
	}

	// A user document only drives the user-scoped appliers; logging in must
	// not be able to reconfigure the whole machine.
	applyFn := apply.Apply
	if username != "" {
		applyFn = apply.ApplyUser
	}
	results := applyFn(ctx, document.Settings, env)
	// Certificates need the control plane, not just the file system, so they
	// are not an applier: the machine asks for one for itself and installs
	// what comes back.
	if username == "" {
		results = append(results, enrol.Apply(ctx, document.Settings, env, api)...)
	}
	failed := 0
	for _, result := range results {
		if result.Status == "failed" {
			failed++
			fmt.Fprintf(os.Stderr, "  %-40s %s: %s\n", result.Setting, result.Status, result.Reason)
		} else {
			fmt.Printf("  %-40s %s\n", result.Setting, result.Status)
		}
	}

	// Work queued for this machine — a role to install, a share to render —
	// is collected on the same visit rather than needing a poll of its own.
	_ = runTasks(ctx, api, env)
	reportInventory(ctx, api, env)

	report := policy.Report{
		PolicySerial: document.Serial,
		AppliedGPOs:  document.AppliedGPOs,
		Results:      results,
	}
	// A password this run generated travels with the report and nowhere else.
	if rotated := apply.TakePendingLocalAdministrator(); rotated != nil {
		report.LocalAdministrator = &policy.LocalAdministratorCredential{
			Account:   rotated.Account,
			Password:  rotated.Password,
			Rotated:   rotated.Rotated.Format(time.RFC3339),
			ExpiresAt: rotated.ExpiresAt.Format(time.RFC3339),
		}
	}
	if err := api.Report(ctx, report); err != nil {
		return fmt.Errorf("reporting results: %w", err)
	}
	// Only when everything applied. Recording the serial after a failure means
	// the next run says "policy unchanged" and skips it, so a setting that
	// failed for a passing reason — a share that was down, a package the
	// mirror did not have yet — is never tried again until somebody edits the
	// policy object.
	if username == "" && failed == 0 {
		saveSerial(env, document.Serial)
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d settings failed", failed, len(results))
	}
	return nil
}

func runTasks(ctx context.Context, api *client.Client, env apply.Env) bool {
	queued, err := api.Tasks(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent: fetching tasks:", err)
		return false
	}
	return runQueued(ctx, api, env, queued)
}

// runQueued reports whether one of the tasks asked for the policy to be
// applied again.
func runQueued(
	ctx context.Context, api *client.Client, env apply.Env, queued []tasks.Task,
) bool {
	refresh := false
	for _, task := range queued {
		if task.Kind == "policy-refresh" {
			refresh = true
		}
		fmt.Printf("  task %-16s running\n", task.Kind)
		// The console shows this while the task runs, so an install that
		// takes ten minutes reads as an install rather than as a hang. A
		// failure to report progress is not a failure of the task.
		progress := func(output string) {
			if err := api.TaskProgress(ctx, task.ID, output); err != nil {
				fmt.Fprintln(os.Stderr, "odm-agent: reporting progress:", err)
			}
		}
		result := tasks.RunWithProgress(ctx, task, env, progress)
		if !result.OK {
			fmt.Fprintf(os.Stderr, "  task %-16s failed: %s\n", task.Kind, result.Output)
		}
		if err := api.TaskResult(ctx, result); err != nil {
			fmt.Fprintln(os.Stderr, "odm-agent: reporting task:", err)
			// A result the control plane will not take leaves the task
			// claimed and the console saying "installing" with the work
			// long finished — which is what a too-long output did. The
			// outcome matters more than the transcript, so say it again
			// with almost none of one.
			short := result
			short.Output = lastLines(result.Output, 20)
			if err := api.TaskResult(ctx, short); err != nil {
				fmt.Fprintln(os.Stderr, "odm-agent: reporting task, briefly:", err)
			}
		}
	}
	return refresh
}

// reportInventory tells the control plane what this machine looks like. It is
// never fatal: a machine that cannot report its local users has still applied
// its policy, and saying nothing about that would be worse than saying this.
func reportInventory(ctx context.Context, api *client.Client, env apply.Env) {
	report := inventory.Collect(ctx, env)
	if err := api.Inventory(ctx, report); err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent: reporting inventory:", err)
		return
	}
	// Only advance the journal position once the entries are safely reported,
	// or a failed report would lose them.
	if report.LogCursor != "" {
		full := env.Path(inventory.CursorPath)
		if err := os.MkdirAll(filepath.Dir(full), 0o750); err == nil {
			_ = os.WriteFile(full, []byte(report.LogCursor), 0o600)
		}
	}
}

func lastSerial(env apply.Env) string {
	raw, err := os.ReadFile(env.Path(serialPath))
	if err != nil {
		return ""
	}
	return string(raw)
}

func saveSerial(env apply.Env, serial string) {
	full := env.Path(serialPath)
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err == nil {
		_ = os.WriteFile(full, []byte(serial), 0o600)
	}
}

// jitter spreads a fleet's check-ins so a thousand machines do not all wake
// at the same second.
func jitter(interval time.Duration) time.Duration {
	span := int64(interval / 10)
	if span <= 0 {
		return 0
	}
	n, err := rand.Int(rand.Reader, big.NewInt(span))
	if err != nil {
		return 0
	}
	return time.Duration(n.Int64())
}

// lastLines keeps the end of some output, which is where a command says how
// it went.
func lastLines(text string, count int) string {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(lines) > count {
		lines = lines[len(lines)-count:]
	}
	kept := strings.Join(lines, "\n")
	// Belt and braces: twenty lines of one very long line is still long.
	if len(kept) > 2000 {
		kept = kept[len(kept)-2000:]
	}
	return kept
}
