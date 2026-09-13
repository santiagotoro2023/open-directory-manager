package apply

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// The graphical boot splash (CLAUDE.md §3.5), on top of the kernel command
// line grub.go writes.
//
// Plymouth is what every mainstream desktop Linux distribution already uses
// for this — a spinner in place of the kernel and initramfs text a boot
// otherwise shows on its way to the login screen — so this installs and
// configures it rather than drawing anything of its own. Its "spinner"
// theme, not a theme this writes, is what actually renders: it ships in
// plymouth-themes, needs no custom boot-time code that could leave a machine
// stuck on a black screen if it were wrong, and already supports the two
// things an operator can brand it with — a small watermark logo, and a
// status message shown through Plymouth's own display-message command.
// A full custom background picture is deliberately not offered: Plymouth's
// built-in themes have no config key for one, and a hand-written theme
// script is boot-time code this cannot test against a real display before
// it ships.
const (
	splashPackages      = "plymouth plymouth-themes"
	splashTheme         = "spinner"
	splashThemeDir      = "/usr/share/plymouth/themes/spinner"
	splashWatermarkPath = splashThemeDir + "/watermark.png"
	splashWatermarkSum  = "/var/lib/odm/boot-splash-watermark.sha256"

	splashMessagePath = "/etc/odm/boot-splash-message.txt"
	splashUnitPath    = "/etc/systemd/system/odm-boot-message.service"
)

// The unit is static and carries no operator-supplied text of its own — the
// message lives in splashMessagePath instead, read through a command
// substitution rather than interpolated into the unit file, so nothing a
// policy sets ever becomes part of a file systemd itself parses as syntax.
// ConditionPathExists means an unset message is "nothing to do" rather than
// a failed unit on every boot of a machine that has never set one.
const splashUnit = Header + `[Unit]
Description=Open Directory Manager boot splash message
After=plymouth-start.service
Before=plymouth-quit-wait.service
ConditionPathExists=` + splashMessagePath + `

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'plymouth display-message --text="$(cat ` + splashMessagePath + `)"'

[Install]
WantedBy=sysinit.target
`

func applyBootSplash(ctx context.Context, g *policy.Grub, env Env) []policy.Result {
	if !g.BootSplash {
		return disableBootSplash(env)
	}
	if env.Run == nil {
		return []policy.Result{policy.Skip("grub:splash", "no command runner")}
	}

	var results []policy.Result
	if !plymouthInstalled(env) {
		if out, err := env.Run.Run(ctx, "apt-get", "update", "-qq"); err != nil {
			return []policy.Result{policy.Fail("grub:splash",
				fmt.Errorf("updating the package index: %w: %s", err, lastLine(out)))}
		}
		args := append([]string{"install", "-y", "--no-install-recommends"}, strings.Fields(splashPackages)...)
		if out, err := env.Run.Run(ctx, "apt-get", args...); err != nil {
			return []policy.Result{policy.Fail("grub:splash",
				fmt.Errorf("installing plymouth: %w: %s", err, lastLine(out)))}
		}
	}

	needsRebuild := !themeIsSpinner(ctx, env)
	watermarkChanged, err := applyWatermark(g.SplashImage, env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", err))
	}
	needsRebuild = needsRebuild || watermarkChanged

	if needsRebuild {
		// -R rebuilds the initramfs with this theme baked in; without it the
		// theme is set for next time update-initramfs runs for some other
		// reason, and the machine boots on whatever theme it already had.
		if out, err := env.Run.Run(ctx, "plymouth-set-default-theme", splashTheme, "-R"); err != nil {
			results = append(results, policy.Result{
				Setting: "grub:splash", Status: "failed",
				Reason: fmt.Sprintf("setting the boot splash theme: %v: %s", err, lastLine(out)),
			})
		} else {
			results = append(results, policy.Ok("grub:splash"))
		}
	} else {
		results = append(results, policy.Ok("grub:splash"))
	}

	results = append(results, applySplashMessage(ctx, g.SplashMessage, env)...)
	return results
}

// disableBootSplash removes what this machine's own installer would have
// added, on a machine whose policy no longer asks for a splash. Plymouth
// itself is left installed: an operator who turned this off asked for the
// splash to stop, not for a package removed — grub.go already stopped
// writing "quiet splash" onto the kernel command line, which is what
// actually keeps it from showing.
func disableBootSplash(env Env) []policy.Result {
	var results []policy.Result
	if _, err := os.Stat(env.Path(splashMessagePath)); err == nil {
		if err := os.Remove(env.Path(splashMessagePath)); err != nil {
			results = append(results, policy.Fail("grub:splash", err))
		}
	}
	return results
}

// plymouthInstalled reports whether the tool this configures is present,
// checked by path rather than by running it: a machine with no command
// runner still has a filesystem this can look at.
func plymouthInstalled(env Env) bool {
	_, err := os.Stat(env.Path("/usr/sbin/plymouth-set-default-theme"))
	return err == nil
}

// themeIsSpinner reports whether this machine's default theme is already
// the one this sets, so an unchanged policy does not rebuild the initramfs
// on every refresh — that rebuild is seconds long and not something to pay
// on every fifteen-minute poll for a setting that has not changed.
func themeIsSpinner(ctx context.Context, env Env) bool {
	out, err := env.Run.Run(ctx, "plymouth-set-default-theme")
	return err == nil && strings.TrimSpace(out) == splashTheme
}

// applyWatermark writes or removes the logo the spinner theme shows,
// reporting whether it actually changed anything — which is what decides
// whether the initramfs needs rebuilding, not merely whether an image was
// supplied.
func applyWatermark(image string, env Env) (changed bool, err error) {
	if image == "" {
		if _, statErr := os.Stat(env.Path(splashWatermarkPath)); statErr != nil {
			return false, nil
		}
		_ = os.Remove(env.Path(splashWatermarkPath))
		_ = os.Remove(env.Path(splashWatermarkSum))
		return true, nil
	}

	raw, decodeErr := base64.StdEncoding.DecodeString(image)
	if decodeErr != nil {
		return false, fmt.Errorf("splash logo: %w", decodeErr)
	}
	sum := fmt.Sprintf("%x", sha256.Sum256(raw))
	if current, readErr := os.ReadFile(env.Path(splashWatermarkSum)); readErr == nil &&
		strings.TrimSpace(string(current)) == sum {
		return false, nil
	}
	if err := env.WriteFile(splashWatermarkPath, string(raw), 0o644, "root", "root"); err != nil {
		return false, fmt.Errorf("writing the splash logo: %w", err)
	}
	if err := env.WriteFile(splashWatermarkSum, sum+"\n", 0o600, "root", "root"); err != nil {
		return false, fmt.Errorf("recording the splash logo: %w", err)
	}
	return true, nil
}

// applySplashMessage writes the systemd unit once and keeps the message it
// reads current. The unit itself never changes: only the file it reads at
// boot does, so a message can be added, changed or cleared without a
// daemon-reload or a service restart, and clearing it back to nothing is
// deleting a text file rather than disabling anything.
func applySplashMessage(ctx context.Context, message string, env Env) []policy.Result {
	var results []policy.Result
	if _, err := os.Stat(env.Path(splashUnitPath)); err != nil {
		if err := env.WriteFile(splashUnitPath, splashUnit, 0o644, "root", "root"); err != nil {
			return []policy.Result{policy.Fail("grub:splash_message", err)}
		}
		results = append(results, runAll(ctx, env, "grub:splash_message",
			[]string{"systemctl", "daemon-reload"},
			[]string{"systemctl", "enable", "odm-boot-message.service"},
		))
	}

	if message == "" {
		if _, err := os.Stat(env.Path(splashMessagePath)); err == nil {
			_ = os.Remove(env.Path(splashMessagePath))
		}
		return results
	}
	if err := env.WriteFile(splashMessagePath, message+"\n", 0o644, "root", "root"); err != nil {
		return append(results, policy.Fail("grub:splash_message", err))
	}
	return results
}
