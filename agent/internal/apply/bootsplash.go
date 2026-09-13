package apply

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"fmt"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
	"syscall"

	"odm.example.org/agent/internal/policy"
)

// The graphical boot splash (CLAUDE.md §3.5), on top of the kernel command
// line grub.go writes.
//
// Plymouth is what every mainstream desktop Linux distribution already uses
// for this — a spinner in place of the kernel and initramfs text a boot
// otherwise shows on its way to the login screen — so this installs and
// drives it rather than drawing anything outside Plymouth's own drawing API.
// Its built-in themes cover a spinner, a solid background and a small
// watermark logo, but have no setting for a full custom background picture,
// so a full background is a small theme of this project's own — written
// once, in Plymouth's own Script language, using only long-standing,
// documented primitives every one of Plymouth's own bundled themes is built
// from (Window.SetBackgroundTopColor, Image, Sprite, SetImage, SetX/SetY/
// SetZ, Plymouth.SetRefreshFunction, Plymouth.SetMessageFunction).
// Nothing in it reaches outside Plymouth's own sandboxed drawing API: no
// file access, no shell, no network from the script itself. The one part of
// this drawn without a real display to check it against — the spin
// animation — is not script logic but a set of pre-rendered frames
// generated once and shipped as plain image assets, the same as the logo or
// background an operator uploads.
const (
	splashPackages = "plymouth plymouth-themes"
	splashTheme    = "odm-boot"
	splashThemeDir = "/usr/share/plymouth/themes/odm-boot"

	splashWatermarkPath  = splashThemeDir + "/watermark.png"
	splashBackgroundPath = splashThemeDir + "/background.png"
	splashAssetSumPath   = "/var/lib/odm/boot-splash-assets.sha256"

	splashMessagePath = "/etc/odm/boot-splash-message.txt"
	splashUnitPath    = "/etc/systemd/system/odm-boot-message.service"
)

//go:embed assets/bootsplash
var splashAssets embed.FS

const splashAssetsRoot = "assets/bootsplash"

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

	themeChanged, err := writeSplashTheme(env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", err))
	}
	watermarkChanged, err := applyImageAsset(splashWatermarkPath, g.SplashImage, env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", fmt.Errorf("splash logo: %w", err)))
	}
	backgroundChanged, err := applyImageAsset(splashBackgroundPath, g.SplashBackground, env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", fmt.Errorf("splash background: %w", err)))
	}
	nvidiaModulesChanged, err := ensureNvidiaModulesInInitramfs(env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", fmt.Errorf("nvidia modules: %w", err)))
	}
	kmsModulesChanged, err := ensureOpenSourceKmsModulesInInitramfs(env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", fmt.Errorf("kms modules: %w", err)))
	}

	needsRebuild := !themeIsActive(ctx, env) || themeChanged || watermarkChanged || backgroundChanged ||
		nvidiaModulesChanged || kmsModulesChanged
	if needsRebuild {
		// A rebuild that runs out of room on /boot can leave a truncated
		// initrd behind — one that boots straight to an "(initramfs)" rescue
		// prompt on every machine it happened on, with no login screen ever
		// reached again until someone rescues it by hand. Checked before
		// rather than after: leaving the last-known-good image in place and
		// failing loudly here is always recoverable, replacing it with a
		// half-written one is not.
		if ok, spaceErr := sufficientBootSpace(env); spaceErr == nil && !ok {
			results = append(results, policy.Fail("grub:splash",
				fmt.Errorf("not enough free space on /boot to safely rebuild the initramfs; leaving the existing boot image in place")))
		} else if out, err := env.Run.Run(ctx, "plymouth-set-default-theme", splashTheme, "-R"); err != nil {
			// -R rebuilds the initramfs with this theme baked in; without it
			// the theme is set for next time update-initramfs runs for some
			// other reason, and the machine boots on whatever theme it
			// already had.
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

// themeIsActive reports whether this machine's default theme is already the
// one this sets, so an unchanged policy does not rebuild the initramfs on
// every refresh — that rebuild is seconds long and not something to pay on
// every fifteen-minute poll for a setting that has not changed.
func themeIsActive(ctx context.Context, env Env) bool {
	out, err := env.Run.Run(ctx, "plymouth-set-default-theme")
	return err == nil && strings.TrimSpace(out) == splashTheme
}

// nvidiaProprietaryDriverInUse reports whether this machine's graphics are
// driven by the closed nvidia driver rather than nouveau or anything else —
// confirmed live against real hardware to matter: without it, Plymouth is
// never given a display to draw on at all, and every kernel and systemd
// message this setting exists to hide keeps showing on the console's plain
// firmware framebuffer for the whole of early boot, whatever the theme
// itself says. Checked by path rather than by asking the kernel, so a
// machine with no command runner still has a filesystem this can look at.
func nvidiaProprietaryDriverInUse(env Env) bool {
	for _, marker := range []string{"/proc/driver/nvidia/version", "/usr/bin/nvidia-smi"} {
		if _, err := os.Stat(env.Path(marker)); err == nil {
			return true
		}
	}
	return false
}

const initramfsModulesPath = "/etc/initramfs-tools/modules"

// ensureNvidiaModulesInInitramfs is the other half of nvidia-drm.modeset=1 on
// the kernel command line: mode setting has nothing to turn on early if the
// driver itself is not in the initramfs to begin with. update-initramfs
// resolves nvidia_drm's own dependencies (nvidia_modeset, nvidia) the same
// way modprobe does, so naming it is enough — the other two are listed
// anyway, since a machine that already has one of them by some other means
// should not end up missing another.
func ensureNvidiaModulesInInitramfs(env Env) (changed bool, err error) {
	if !nvidiaProprietaryDriverInUse(env) {
		return false, nil
	}
	return addModulesToInitramfs(env, []string{"nvidia", "nvidia_modeset", "nvidia_drm"})
}

// openSourceKmsModules gives Plymouth something to draw on for early Kernel
// Mode Setting on the open-source drivers, the non-nvidia counterpart to
// ensureNvidiaModulesInInitramfs above. An earlier version of this instead
// widened /etc/initramfs-tools/initramfs.conf's MODULES= setting to "most",
// which pulls every module for every class of hardware the running kernel
// knows about — network, sound, USB storage, Bluetooth, every filesystem —
// into the initramfs, not just the display drivers this needs. Confirmed
// live: on a machine with a small /boot partition and more than one kernel
// already installed (ordinary after a few unattended-upgrades cycles that
// never got an autoremove), that made the rebuilt initramfs too big for the
// partition to hold, and the rebuild left a truncated image behind — a
// machine that boots straight to an "(initramfs)" rescue shell and never
// reaches a login screen again, on every machine the policy reached, not
// just ones with unusual hardware. Naming the handful of drivers actually
// needed keeps the initrd within a few hundred kilobytes of what it already
// was, the same bounded, one-file mechanism the nvidia modules already use
// safely above.
var openSourceKmsModules = []string{"amdgpu", "i915", "radeon", "nouveau"}

func ensureOpenSourceKmsModulesInInitramfs(env Env) (changed bool, err error) {
	return addModulesToInitramfs(env, openSourceKmsModules)
}

// addModulesToInitramfs force-includes the given modules regardless of the
// machine's MODULES= mode — this file is read in addition to whatever that
// setting already resolves to, not instead of it, so it never has to touch
// or widen that setting to get a specific module included.
func addModulesToInitramfs(env Env, modules []string) (changed bool, err error) {
	existing, err := os.ReadFile(env.Path(initramfsModulesPath))
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	present := map[string]bool{}
	for _, line := range strings.Split(string(existing), "\n") {
		present[strings.TrimSpace(line)] = true
	}

	body := string(existing)
	for _, module := range modules {
		if present[module] {
			continue
		}
		if body != "" && !strings.HasSuffix(body, "\n") {
			body += "\n"
		}
		body += module + "\n"
		changed = true
	}
	if !changed {
		return false, nil
	}
	if err := env.WriteFile(initramfsModulesPath, body, 0o644, "root", "root"); err != nil {
		return false, err
	}
	return true, nil
}

// minBootFreeBytes is the headroom required on /boot before this will start
// an initramfs rebuild. A stock Debian initrd with a handful of extra named
// modules (as opposed to the "most" module set this deliberately avoids
// above) runs well under this; the margin is for the old image, which
// update-initramfs keeps on disk alongside the new one until the rebuild
// finishes, plus whatever else already lives on a typically small /boot
// partition.
const minBootFreeBytes = 200 * 1024 * 1024

// sufficientBootSpace reports whether /boot has enough room to rebuild the
// initramfs without running out of space mid-write. A stat failure (no
// /boot mount, a sandboxed test environment) is reported as an error so the
// caller can choose to proceed rather than block a machine that has no such
// partition to begin with.
func sufficientBootSpace(env Env) (bool, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(env.Path("/boot"), &stat); err != nil {
		return false, err
	}
	return stat.Bavail*uint64(stat.Bsize) >= minBootFreeBytes, nil
}

// writeSplashTheme installs this project's own theme — the script, its
// descriptor and the pre-rendered spin frames, all embedded in the agent
// binary — and reports whether any of it actually changed. A signature of
// every embedded file together is what decides that, rather than each
// file's own mtime, so an agent upgrade that changes the script is picked
// up the same way a changed logo is: by rebuilding once, not on every pass.
func writeSplashTheme(env Env) (changed bool, err error) {
	names, err := splashAssetNames()
	if err != nil {
		return false, err
	}

	hash := sha256.New()
	for _, name := range names {
		content, err := splashAssets.ReadFile(path.Join(splashAssetsRoot, name))
		if err != nil {
			return false, fmt.Errorf("reading the bundled %s: %w", name, err)
		}
		hash.Write([]byte(name))
		hash.Write(content)
		if err := env.WriteFile(path.Join(splashThemeDir, name), string(content), 0o644, "root", "root"); err != nil {
			return false, fmt.Errorf("writing %s: %w", name, err)
		}
	}
	sum := fmt.Sprintf("%x", hash.Sum(nil))

	if current, readErr := os.ReadFile(env.Path(splashAssetSumPath)); readErr == nil &&
		strings.TrimSpace(string(current)) == sum {
		return false, nil
	}
	if err := env.WriteFile(splashAssetSumPath, sum+"\n", 0o600, "root", "root"); err != nil {
		return false, fmt.Errorf("recording the theme's signature: %w", err)
	}
	return true, nil
}

// splashAssetNames lists the embedded theme files by name, sorted so the
// combined signature writeSplashTheme hashes them in does not depend on
// filesystem iteration order.
func splashAssetNames() ([]string, error) {
	var names []string
	err := fs.WalkDir(splashAssets, splashAssetsRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			names = append(names, strings.TrimPrefix(p, splashAssetsRoot+"/"))
		}
		return nil
	})
	sort.Strings(names)
	return names, err
}

// applyImageAsset writes or removes one of the two pictures an operator may
// upload — the logo or the background — reporting whether it actually
// changed anything, which is what decides whether the initramfs needs
// rebuilding rather than merely whether a picture was supplied. Shared
// because the logo and the background are the same operation on two
// different files: decode, compare against what is already there, write.
func applyImageAsset(dest, image string, env Env) (changed bool, err error) {
	sumPath := dest + ".sha256"
	if image == "" {
		if _, statErr := os.Stat(env.Path(dest)); statErr != nil {
			return false, nil
		}
		_ = os.Remove(env.Path(dest))
		_ = os.Remove(env.Path(sumPath))
		return true, nil
	}

	raw, decodeErr := base64.StdEncoding.DecodeString(image)
	if decodeErr != nil {
		return false, fmt.Errorf("not valid base64: %w", decodeErr)
	}
	sum := fmt.Sprintf("%x", sha256.Sum256(raw))
	if current, readErr := os.ReadFile(env.Path(sumPath)); readErr == nil &&
		strings.TrimSpace(string(current)) == sum {
		return false, nil
	}
	if err := env.WriteFile(dest, string(raw), 0o644, "root", "root"); err != nil {
		return false, fmt.Errorf("writing %s: %w", dest, err)
	}
	if err := env.WriteFile(sumPath, sum+"\n", 0o600, "root", "root"); err != nil {
		return false, fmt.Errorf("recording %s: %w", dest, err)
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
