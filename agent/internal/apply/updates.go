package apply

import (
	"context"
	"fmt"
	"os"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Unattended updates.
//
// Written as the two configuration files unattended-upgrades reads, which is
// Debian's own mechanism: a timer of ODM's own would duplicate one the
// distribution already ships and tests.
const (
	periodicPath   = "/etc/apt/apt.conf.d/20odm-auto-upgrades"
	unattendedPath = "/etc/apt/apt.conf.d/51odm-unattended-upgrades"

	managedHeader = "// Managed by Open Directory Manager. Edits here are overwritten.\n"
)

func applyUpdates(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.Updates == nil {
		return nil
	}
	settings := *s.Updates

	if !settings.Enabled {
		// Turning it off means removing what ODM wrote, not writing "off":
		// a leftover file would keep overriding the machine's own setting.
		removed := 0
		for _, path := range []string{periodicPath, unattendedPath} {
			if err := os.Remove(env.Path(path)); err == nil {
				removed++
			}
		}
		return []policy.Result{{
			Setting: "updates",
			Status:  "applied",
			Reason:  fmt.Sprintf("unattended upgrades off; %d files removed", removed),
		}}
	}

	// unattended-upgrades counts in days, so a weekly schedule is 7.
	interval := "1"
	if settings.Schedule == "weekly" {
		interval = "7"
	}
	periodic := managedHeader +
		fmt.Sprintf("APT::Periodic::Update-Package-Lists \"%s\";\n", interval) +
		fmt.Sprintf("APT::Periodic::Unattended-Upgrade \"%s\";\n", interval) +
		"APT::Periodic::AutocleanInterval \"7\";\n"

	origins := []string{`"${distro_id}:${distro_codename}-security"`,
		`"${distro_id}ESMApps:${distro_codename}-apps-security"`}
	if !settings.SecurityOnly {
		origins = append(origins,
			`"${distro_id}:${distro_codename}"`,
			`"${distro_id}:${distro_codename}-updates"`)
	}

	var unattended strings.Builder
	unattended.WriteString(managedHeader)
	unattended.WriteString("Unattended-Upgrade::Origins-Pattern {\n")
	for _, origin := range origins {
		fmt.Fprintf(&unattended, "    %s;\n", origin)
	}
	unattended.WriteString("};\n")
	fmt.Fprintf(&unattended, "Unattended-Upgrade::Remove-Unused-Dependencies \"%s\";\n",
		yesNo(settings.RemoveUnused))
	fmt.Fprintf(&unattended, "Unattended-Upgrade::Automatic-Reboot \"%s\";\n",
		yesNo(settings.AutoReboot))
	if settings.AutoReboot {
		fmt.Fprintf(&unattended, "Unattended-Upgrade::Automatic-Reboot-Time \"%s\";\n",
			settings.RebootTime)
	}

	results := []policy.Result{}
	// The package is what actually runs these files; without it they are inert.
	results = append(results, runAll(ctx, env, "updates:install",
		[]string{"apt-get", "install", "-y", "--no-install-recommends", "unattended-upgrades"}))

	for _, file := range []struct {
		setting string
		path    string
		body    string
	}{
		{"updates:schedule", periodicPath, periodic},
		{"updates:policy", unattendedPath, unattended.String()},
	} {
		if err := env.WriteFile(file.path, file.body, 0o644, "root", "root"); err != nil {
			results = append(results, policy.Result{
				Setting: file.setting, Status: "failed", Reason: err.Error(),
			})
			continue
		}
		results = append(results, policy.Result{Setting: file.setting, Status: "applied"})
	}
	return results
}

func yesNo(value bool) string {
	if value {
		return "true"
	}
	return "false"
}
