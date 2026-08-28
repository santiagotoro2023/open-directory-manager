package apply

import (
	"context"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Software deployment (CLAUDE.md §4): apt packages a machine should have,
// should have at the newest available version, or should not have.
//
// The package index is refreshed once per run, and only when there is
// something to do.
func applyPackages(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.Packages) == 0 {
		return nil
	}

	var install, upgrade, remove []string
	for _, pkg := range s.Packages {
		switch pkg.State {
		case "", "present":
			install = append(install, pkg.Name)
		case "latest":
			upgrade = append(upgrade, pkg.Name)
		case "absent":
			remove = append(remove, pkg.Name)
		}
	}

	results := []policy.Result{runAll(ctx, env, "packages:refresh",
		[]string{"apt-get", "update", "-qq"})}

	// Non-interactive, and never a package the policy did not name.
	base := []string{"apt-get", "-y", "-o", "Dpkg::Options::=--force-confold",
		"--no-install-recommends"}

	for _, batch := range []struct {
		setting string
		action  []string
		names   []string
	}{
		{"packages:install", []string{"install"}, install},
		{"packages:upgrade", []string{"install", "--only-upgrade"}, upgrade},
		{"packages:remove", []string{"remove"}, remove},
	} {
		if len(batch.names) == 0 {
			continue
		}
		command := append(append([]string{}, base...), batch.action...)
		command = append(command, batch.names...)
		result := runAll(ctx, env, batch.setting, command)
		result.Reason = strings.Join(batch.names, ", ")
		results = append(results, result)
	}
	return results
}
