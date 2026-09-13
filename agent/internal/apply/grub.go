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
		// Deliberately never asks a real GPU driver to take over kernel mode
		// setting for this. An earlier version added nvidia-drm.modeset=1 (and
		// later nvidia_drm.fbdev=1 alongside it) specifically to give the
		// proprietary NVIDIA driver early KMS, on the reasoning that Plymouth
		// otherwise had nothing to draw on. Confirmed live that this was the
		// wrong fix for the wrong problem: with both parameters correctly
		// applied, Plymouth's DRM renderer still rendered nothing at all —
		// not a missing-driver problem, but a real, reproducible kernel WARN_ON
		// inside NVIDIA's own nvidia_drm.ko (nv_drm_revoke_modeset_permission,
		// hit during the exact drop-master handoff to the login manager),
		// confirmed to have no module parameter or driver-version workaround
		// available in Debian's own repos. "keep" alone already solves the
		// actual problem without touching any vendor driver at all: the
		// kernel's own generic, in-tree simpledrm/efifb driver picks up
		// whatever graphics mode GRUB (via UEFI GOP) already negotiated and
		// exposes it as a plain DRM device Plymouth's renderer can draw onto
		// directly — no NVIDIA, AMD or Intel driver code involved during the
		// splash at all, on any vendor's hardware. The real GPU driver still
		// takes over normally once the desktop session itself starts; this
		// only changes what draws the splash in between.
		body += fmt.Sprintf("GRUB_CMDLINE_LINUX_DEFAULT=%q\n", "quiet splash")
		body += "GRUB_GFXPAYLOAD_LINUX=keep\n"
	}
	if err := env.WriteFile(grubConfPath, body, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("grub", err)}
	}
	results := []policy.Result{runAll(ctx, env, "grub", []string{"update-grub"})}
	return append(results, applyBootSplash(ctx, s.Grub, env)...)
}
