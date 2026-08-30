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

const version = "0.1.0"

const serialPath = "/var/lib/odm/last-serial"

func main() {
	if len(os.Args) < 2 {
		usage()
	}

	switch os.Args[1] {
	case "apply":
		os.Exit(runApply(os.Args[2:]))
	case "daemon":
		os.Exit(runDaemon(os.Args[2:]))
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

func runDaemon(args []string) int {
	flags := flag.NewFlagSet("daemon", flag.ExitOnError)
	configPath := flags.String("config", config.DefaultPath, "agent configuration file")
	root := flags.String("root", "", "write beneath this directory instead of /")
	_ = flags.Parse(args)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	for {
		wait := 15 * time.Minute
		if err := applyOnce(ctx, *configPath, *root, "", false); err != nil {
			fmt.Fprintln(os.Stderr, "odm-agent:", err)
		} else if cfg, err := config.Load(*configPath); err == nil && cfg.RefreshMinutes > 0 {
			wait = time.Duration(cfg.RefreshMinutes) * time.Minute
		}

		if !waitAndPoll(ctx, *configPath, *root, wait+jitter(wait)) {
			return 0
		}
	}
}

// waitAndPoll sleeps until the next policy refresh, checking for queued work
// every taskPoll along the way. Returns false when the agent should stop.
//
// Policy is compared against a serial and applied only when it changes; a task
// is somebody in the console waiting for an answer. Making them share a
// fifteen-minute interval meant clicking Install and watching "installing" for
// a quarter of an hour with no way to tell it apart from a failure. Asking for
// the queue is one small authenticated GET that returns nothing almost every
// time.
//
// ponytail: a fixed poll. If a large estate makes this traffic matter, the
// control plane would have to push instead, which is a connection per machine
// to hold open — a much bigger change than shortening an interval.
const taskPoll = 30 * time.Second

func waitAndPoll(ctx context.Context, configPath, root string, remaining time.Duration) bool {
	// One Kerberos client for the whole window rather than one per poll: a
	// ticket is good for hours, and asking the KDC for a new one every thirty
	// seconds on every machine in the domain is real load for nothing.
	var api *client.Client
	defer func() {
		if api != nil {
			api.Close()
		}
	}()

	for remaining > 0 {
		step := taskPoll
		if remaining < step {
			step = remaining
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(step):
		}
		remaining -= step
		if remaining <= 0 {
			break
		}

		if api == nil {
			cfg, err := config.Load(configPath)
			if err != nil {
				continue
			}
			// A failure here is not worth a log line every thirty seconds;
			// the next policy refresh reports it properly.
			if api, err = client.New(cfg, version); err != nil {
				api = nil
				continue
			}
		}
		runTasks(ctx, api, apply.NewEnv(root))
	}
	return true
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
	runTasks(ctx, api, env)
	reportInventory(ctx, api, env)

	if err := api.Report(ctx, policy.Report{
		PolicySerial: document.Serial,
		AppliedGPOs:  document.AppliedGPOs,
		Results:      results,
	}); err != nil {
		return fmt.Errorf("reporting results: %w", err)
	}
	if username == "" {
		saveSerial(env, document.Serial)
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d settings failed", failed, len(results))
	}
	return nil
}

func runTasks(ctx context.Context, api *client.Client, env apply.Env) {
	queued, err := api.Tasks(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent: fetching tasks:", err)
		return
	}
	for _, task := range queued {
		fmt.Printf("  task %-16s running\n", task.Kind)
		result := tasks.Run(ctx, task, env)
		if !result.OK {
			fmt.Fprintf(os.Stderr, "  task %-16s failed: %s\n", task.Kind, result.Output)
		}
		if err := api.TaskResult(ctx, result); err != nil {
			fmt.Fprintln(os.Stderr, "odm-agent: reporting task:", err)
		}
	}
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
