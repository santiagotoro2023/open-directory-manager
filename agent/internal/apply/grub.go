package apply

import (
	"context"
	"fmt"

	"odm.example.org/agent/internal/policy"
)

// Boot loader timing (CLAUDE.md §3.5): how long GRUB waits, and whether it
// shows its menu at all, before starting the default entry.
//
// Written as a drop-in under /etc/default/grub.d rather than into
// /etc/default/grub itself — Debian's grub-common reads every *.cfg file
// there ahead of update-grub regenerating the real boot configuration, which
// is documented at the top of /etc/default/grub for exactly this reason: so
// something other than an administrator's own editor can change this
// without clobbering whatever else is in that file.
const grubConfPath = "/etc/default/grub.d/00-odm.cfg"

func applyGrub(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.Grub == nil {
		return nil
	}
	timeout := s.Grub.TimeoutSeconds
	if timeout < 0 {
		timeout = 0
	}
	style := "menu"
	if s.Grub.HideMenu {
		// Hidden rather than countdown: this is "the machine just boots",
		// and Escape during boot still reaches the menu for the one time
		// somebody actually needs it.
		style = "hidden"
	}

	body := Header +
		fmt.Sprintf("GRUB_TIMEOUT=%d\n", timeout) +
		fmt.Sprintf("GRUB_TIMEOUT_STYLE=%s\n", style)
	if err := env.WriteFile(grubConfPath, body, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("grub", err)}
	}
	return []policy.Result{runAll(ctx, env, "grub", []string{"update-grub"})}
}
