package tasks

import (
	"context"
	"fmt"
	"os"

	"odm.example.org/agent/internal/apply"
)

// Updating this machine's agent, asked for from the console.
//
// The console hands out the binary it was deployed with, over the channel the
// agent already has: no package repository to reach, no signature scheme of
// its own, and a machine that cannot reach the console is not one an update
// should be reaching anyway.
func updateAgent(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	if env.Download == nil {
		return "", fmt.Errorf("this agent has no connection to the console to download through")
	}
	wanted := str(payload["version"])

	downloaded, offered, err := env.Download(ctx, env.Path(apply.AgentPath))
	if err != nil {
		return "", err
	}
	// Asked for a version this console does not have. Said plainly rather
	// than installing whatever was there instead.
	if wanted != "" && offered != "" && wanted != offered {
		_ = os.Remove(downloaded)
		return "", fmt.Errorf("this console hands out %s, not %s", offered, wanted)
	}
	if wanted == "" && offered != "" && offered == env.Version {
		_ = os.Remove(downloaded)
		return "already on " + offered, nil
	}
	return apply.InstallAgent(ctx, env, downloaded, offered)
}
