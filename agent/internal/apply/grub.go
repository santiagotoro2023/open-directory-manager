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
		cmdline := "quiet splash"
		if nvidiaProprietaryDriverInUse(env) {
			// Confirmed live: without this, the proprietary driver never
			// takes over kernel mode setting, so Plymouth has nothing to
			// draw on for the whole of early boot regardless of how correct
			// the theme is — the console stays on the firmware's own plain
			// framebuffer, showing kernel and systemd text the entire time,
			// on exactly the hardware this setting exists to hide that from.
			//
			// modeset=1 alone confirmed live to be not quite enough on its
			// own: "quiet" successfully suppressed all boot text (proving
			// the kernel and initramfs side was fine), and the theme's own
			// files were correctly present and validated, yet nothing —
			// spinner, background, logo, message — ever appeared, all the
			// way through to the login screen. This is a known rough edge
			// of the proprietary driver's DRM implementation: modeset=1
			// hands the display over, but Plymouth's own DRM renderer still
			// needs the driver's fbdev emulation to actually get a usable
			// framebuffer to draw into. Without fbdev=1, the DRM handoff
			// itself can succeed while Plymouth still has nothing it can
			// actually render onto — which reads as exactly this: no
			// crash, no error anywhere, boot proceeds normally, simply
			// nothing is ever drawn.
			cmdline += " nvidia-drm.modeset=1 nvidia_drm.fbdev=1"
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
