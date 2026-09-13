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
		// A seamless splash still means a hidden menu, but never a
		// zero-second one: a menu that cannot be reached in the instant
		// after power-on cannot rescue a machine whose new boot
		// configuration has a problem nothing caught ahead of time — which
		// is exactly what happened here (CLAUDE.md's boot-splash incident
		// notes). "hidden" style shows nothing and counts down silently for
		// anyone not touching the keyboard, the same as before; any keypress
		// during those two seconds still interrupts to the real menu, the
		// same as any other GRUB screen always has. Two seconds against a
		// splash that itself takes a moment to draw is not a length anyone
		// not deliberately checking will ever notice. A larger explicit
		// TimeoutSeconds is still honoured — this only raises a floor.
		if timeout < 2 {
			timeout = 2
		}
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
		//
		// nvidia-drm.modeset=1 alone — never nvidia_drm.fbdev=1 alongside it
		// — on a machine with the proprietary NVIDIA driver. The full
		// history, across several rounds of this on the same real hardware:
		// plain GRUB_GFXPAYLOAD_LINUX=keep alone, relying only on the
		// kernel's own generic simpledrm/efifb driver with no vendor driver
		// involved at all, rendered nothing. modeset=1 combined with
		// fbdev=1 also rendered nothing. modeset=1 by itself — before
		// fbdev=1 was ever added, and before an unrelated sandboxing bug in
		// this project's own agent was fixed (CLAUDE.md) — is the one
		// combination ever actually seen to render something live. The
		// kernel WARN_ON this project found inside NVIDIA's own
		// nvidia_drm.ko (nv_drm_revoke_modeset_permission) fires during
		// Plymouth's drop-master handoff at the *end* of its active window,
		// not before it — a WARN_ON is not fatal, and every machine that
		// hit it still reached a normal login screen afterward, so it does
		// not rule out Plymouth having already drawn its frames
		// successfully first. fbdev=1 is deliberately not re-added: it is
		// the one variable that changed between a run that rendered
		// something and runs that rendered nothing, which makes it the
		// suspect, not modeset=1 itself.
		cmdline := "quiet splash"
		if nvidiaProprietaryDriverInUse(env) {
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
