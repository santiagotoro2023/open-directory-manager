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
	if s.Grub.BootSplash {
		// A seamless splash and a visible boot menu are a contradiction —
		// the whole point of turning this on is that nothing shows before
		// the spinner, not even the menu for its own timeout window. An
		// operator asking for the splash gets a hidden menu whether or not
		// they separately asked for one.
		timeout = 0
		style = "hidden"
	}

	body := Header +
		fmt.Sprintf("GRUB_TIMEOUT=%d\n", timeout) +
		fmt.Sprintf("GRUB_TIMEOUT_STYLE=%s\n", style)
	if s.Grub.BootSplash {
		// "quiet" is what grub-mkconfig's own 10_linux template checks before
		// it prints "Loading Linux ..." and "Loading initial ramdisk ...": the
		// two lines that flashed on screen even with the menu already hidden,
		// in the gap between GRUB handing off and Plymouth's first frame.
		// GRUB_GFXPAYLOAD_LINUX=keep is what closes that gap on the graphics
		// side — the kernel inherits the same graphics mode GRUB was already
		// in, rather than GRUB resetting to text mode first and the kernel
		// switching back a moment later, which is the flash itself.
		cmdline := "quiet splash"
		if nvidiaProprietaryDriverInUse(env) {
			// Confirmed live: without this, the proprietary driver never
			// takes over kernel mode setting, so Plymouth has nothing to
			// draw on for the whole of early boot regardless of how correct
			// the theme is — the console stays on the firmware's own plain
			// framebuffer, showing kernel and systemd text the entire time,
			// on exactly the hardware this setting exists to hide that from.
			cmdline += " nvidia-drm.modeset=1"
		}
		body += fmt.Sprintf("GRUB_CMDLINE_LINUX_DEFAULT=%q\n", cmdline)
		body += "GRUB_GFXPAYLOAD_LINUX=keep\n"
	}
	if err := env.WriteFile(grubConfPath, body, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("grub", err)}
	}
	results := []policy.Result{runAll(ctx, env, "grub", []string{"update-grub"})}
	return append(results, applyBootSplash(ctx, s.Grub, env)...)
}
