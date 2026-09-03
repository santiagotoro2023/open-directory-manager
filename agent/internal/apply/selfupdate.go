package apply

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Replacing the agent with a newer one, without anybody signing in to the
// machine.
//
// The awkward part is that the thing being replaced is the thing doing the
// replacing. So: the new binary is written beside the old one and renamed
// over it, which is atomic and leaves a running process on the file it
// already opened; then the restart is handed to systemd to do a moment later,
// so this process lives long enough to report what it did. A restart issued
// inline kills the agent mid-task and the console is told nothing.

// AgentPath is where the installer puts it, and so where it is replaced.
const AgentPath = "/usr/sbin/odm-agent"

// InstallAgent moves a downloaded binary into place and schedules the
// restart. The caller has already checked that it is worth doing.
func InstallAgent(ctx context.Context, env Env, downloaded, version string) (string, error) {
	target := env.Path(AgentPath)

	// It has to run before it replaces the one that does. A binary for the
	// wrong architecture, or a truncated one that got past the checksum
	// because the console offered a truncated file, otherwise leaves the
	// machine with no working agent and no way to fix it remotely.
	out, err := env.Run.Run(ctx, downloaded, "--version")
	if err != nil {
		_ = os.Remove(downloaded)
		return "", fmt.Errorf("the downloaded agent will not run here: %w: %s", err, lastLine(out))
	}
	if version == "" {
		version = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(out), "odm-agent"))
	}

	// The one it is replacing, kept. A new agent that starts and immediately
	// dies is the one failure this cannot report, so what it replaced stays
	// on disk for somebody at the machine to put back.
	if previous, err := os.ReadFile(target); err == nil {
		_ = os.WriteFile(target+".previous", previous, 0o755)
	}

	if err := os.Rename(downloaded, target); err != nil {
		_ = os.Remove(downloaded)
		return "", fmt.Errorf("installing the new agent: %w", err)
	}

	// Late enough that this task's result is reported first. systemd-run
	// detaches it from this process, so stopping the service does not stop
	// the thing that starts it again.
	if _, err := env.Run.Run(ctx, "systemd-run",
		"--on-active=5", "--timer-property=AccuracySec=1s", "--collect", "--quiet",
		"--unit=odm-agent-restart",
		"systemctl", "restart", "odm-agent",
	); err != nil {
		return "installed " + version + "; restart it to run it",
			fmt.Errorf("scheduling the restart: %w", err)
	}
	return "updated to " + version + "; restarting in a moment", nil
}

// WantsUpdate decides whether an offer should be taken, given the policy.
//
// Kept apart from everything that touches the disk so the decision is
// testable on its own: this is the part that must never update a machine the
// operator did not ask to update.
func WantsUpdate(mode, pinned, offered, running string) (bool, string) {
	switch mode {
	case "install":
	case "notify", "", "off":
		return false, ""
	default:
		return false, ""
	}
	if offered == "" {
		return false, "the console has no agent to hand out"
	}
	if pinned != "" {
		// Pinned means pinned, in both directions: a machine ahead of the
		// version the domain has settled on goes back to it.
		if pinned == running {
			return false, ""
		}
		if pinned != offered {
			return false, fmt.Sprintf(
				"policy pins %s and the console has %s", pinned, offered)
		}
		return true, ""
	}
	if !Newer(offered, running) {
		return false, ""
	}
	return true, ""
}

// Newer compares versions as numbers. As text "0.7.9" sorts after "0.7.12",
// which would have stopped a domain updating at the tenth patch release.
func Newer(offered, running string) bool {
	if offered == "" {
		return false
	}
	if running == "" {
		return true
	}
	left, right := versionParts(offered), versionParts(running)
	for index := range left {
		if left[index] != right[index] {
			return left[index] > right[index]
		}
	}
	return false
}

func versionParts(version string) [3]int {
	var parts [3]int
	for index, field := range strings.SplitN(strings.TrimSpace(version), ".", 3) {
		if index > 2 {
			break
		}
		digits := strings.TrimFunc(field, func(r rune) bool { return r < '0' || r > '9' })
		parts[index], _ = strconv.Atoi(digits)
	}
	return parts
}

// PreviousAgent is where the replaced binary is kept.
func PreviousAgent(env Env) string { return filepath.Join(env.Path(AgentPath) + ".previous") }

// applyAgentUpdate takes the console's agent when policy says to.
//
// Reported either way. "notify" is the mode that changes nothing and says
// what would change, which is what makes a fleet's versions visible from the
// console without visiting a machine.
func applyAgentUpdate(ctx context.Context, settings policy.Settings, env Env) []policy.Result {
	wanted := settings.AgentUpdate
	if wanted == nil {
		return nil
	}
	mode := wanted.Mode
	if mode == "" {
		mode = "off"
	}
	running := env.Version
	if running == "" {
		running = "unknown"
	}

	if mode == "off" {
		return nil
	}
	if mode == "notify" {
		if env.Offered != "" && Newer(env.Offered, env.Version) {
			return []policy.Result{{
				Setting: "agent_update",
				Status:  "skipped",
				Reason:  fmt.Sprintf("on %s; %s is available", running, env.Offered),
			}}
		}
		return []policy.Result{{
			Setting: "agent_update", Status: "success", Reason: "on " + running,
		}}
	}

	take, why := WantsUpdate(mode, wanted.Version, env.Offered, env.Version)
	if !take {
		if why != "" {
			return []policy.Result{{Setting: "agent_update", Status: "skipped", Reason: why}}
		}
		return []policy.Result{{
			Setting: "agent_update", Status: "success", Reason: "on " + running,
		}}
	}
	if env.Download == nil {
		return []policy.Result{{
			Setting: "agent_update",
			Status:  "failed",
			Reason:  "no connection to the console to download through",
		}}
	}
	downloaded, offered, err := env.Download(ctx, env.Path(AgentPath))
	if err != nil {
		return []policy.Result{{Setting: "agent_update", Status: "failed", Reason: err.Error()}}
	}
	detail, err := InstallAgent(ctx, env, downloaded, offered)
	if err != nil {
		return []policy.Result{{Setting: "agent_update", Status: "failed", Reason: err.Error()}}
	}
	return []policy.Result{{Setting: "agent_update", Status: "success", Reason: detail}}
}
