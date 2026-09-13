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
		// On the proprietary NVIDIA driver, both parameters together, which
		// is the configuration NVIDIA's own documentation and every
		// independent working write-up for this combination specify:
		// modeset=1 hands kernel mode setting to the driver, and fbdev=1
		// makes nvidia-drm provide /dev/fb0 itself rather than leaving
		// Plymouth looking for an efifb that nvidia has already evicted.
		// bootsplash.go writes the same two as module options under
		// /etc/modprobe.d as well, which is what actually applies when the
		// module is loaded by name inside the initramfs.
		//
		// Four earlier attempts at this setting each changed one of these
		// parameters and each rendered nothing, which made the parameters
		// look like the problem. They were not: bootsplash.go was
		// force-loading nouveau into the same initramfs the whole time,
		// which evicts the display and then fails on hardware the
		// proprietary driver owns. See the comment on nvidiaModprobeConf.
		cmdline := "quiet splash"
		if nvidiaProprietaryDriverInUse(env) {
			cmdline += " nvidia-drm.modeset=1 nvidia-drm.fbdev=1"
		}
		body += fmt.Sprintf("GRUB_CMDLINE_LINUX_DEFAULT=%q\n", cmdline)
		// auto is already grub-mkconfig's own default, but it is the mode
		// GRUB_GFXPAYLOAD_LINUX=keep then hands the kernel, so it is worth
		// being explicit about rather than inheriting from whatever else
		// happens to be in /etc/default/grub: "auto" is what asks the
		// firmware for the display's own preferred mode, which is what
		// keeps the splash at the panel's native resolution instead of
		// something the monitor then stretches to fit.
		body += "GRUB_GFXMODE=auto\n"
		body += "GRUB_GFXPAYLOAD_LINUX=keep\n"
	}
	if err := env.WriteFile(grubConfPath, body, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("grub", err)}
	}
	results := []policy.Result{runAll(ctx, env, "grub", []string{"update-grub"})}
	return append(results, applyBootSplash(ctx, s.Grub, env)...)
}
