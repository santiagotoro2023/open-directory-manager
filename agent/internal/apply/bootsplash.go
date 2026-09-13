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
		// Unsandboxed, like every other package install this agent runs
		// (CLAUDE.md, ccache.go, rdpclient.go): odm-agent.service's own
		// hardening is not inherited by a transient unit systemd-run starts
		// fresh, but it is inherited by anything spawned directly as this
		// service's own child. A plain env.Run.Run here silently ran
		// plymouth's install under that hardening instead of escaping it.
		if out, err := Unsandboxed(ctx, env, "apt-get", "update", "-qq"); err != nil {
			return []policy.Result{policy.Fail("grub:splash",
				fmt.Errorf("updating the package index: %w: %s", err, lastLine(out)))}
		}
		args := append([]string{"install", "-y", "--no-install-recommends"}, strings.Fields(splashPackages)...)
		if out, err := Unsandboxed(ctx, env, "apt-get", args...); err != nil {
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
	nvidiaModprobeChanged, err := ensureNvidiaModprobeConf(env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", fmt.Errorf("nvidia module options: %w", err)))
	}
	kmsModulesChanged, err := ensureOpenSourceKmsModulesInInitramfs(env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", fmt.Errorf("kms modules: %w", err)))
	}
	storageModulesChanged, err := ensureStorageModulesInInitramfs(env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", fmt.Errorf("storage modules: %w", err)))
	}
	inputModulesChanged, err := ensureInputModulesInInitramfs(env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", fmt.Errorf("input modules: %w", err)))
	}

	needsRebuild := !themeIsActive(ctx, env) || themeChanged || watermarkChanged || backgroundChanged ||
		nvidiaModulesChanged || nvidiaModprobeChanged || kmsModulesChanged ||
		storageModulesChanged || inputModulesChanged
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
		} else {
			results = append(results, rebuildInitramfsSafely(ctx, env))
		}
	} else {
		results = append(results, policy.Ok("grub:splash"))
	}

	results = append(results, applySplashMessage(ctx, g.SplashMessage, env)...)
	if advisory := fallbackKernelAdvisory(env); advisory != nil {
		results = append(results, *advisory)
	}
	return results
}

// fallbackKernelAdvisory is the other half of grub.go's two-second timeout
// floor: that keeps GRUB's menu reachable, but a reachable menu with only
// one kernel entry in it has nothing else to boot into. Reported, not
// enforced — a single-kernel machine is a legitimate choice, not itself a
// misconfiguration — so this shows up in RSoP for the operator to weigh,
// the same audit trail CLAUDE.md already treats as a real security and
// reliability control, not just a UX nicety.
func fallbackKernelAdvisory(env Env) *policy.Result {
	entries, err := os.ReadDir(env.Path("/boot"))
	if err != nil {
		return nil
	}
	kernels := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "vmlinuz-") {
			kernels++
		}
	}
	if kernels > 1 {
		return nil
	}
	return &policy.Result{
		Setting: "grub:splash_fallback",
		Status:  "success",
		Reason: "only one kernel is installed on this machine, so GRUB's menu has no fallback entry " +
			"to offer if this setting's rebuild has a problem no automated check caught. Keeping at " +
			"least two kernels (Debian's own default, from before any local pruning) makes the boot " +
			"menu — reachable with any keypress in the first two seconds of boot — a real way back.",
	}
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
// driven by the closed nvidia driver rather than nouveau or anything else.
// Checked by path rather than by asking the kernel, so a machine with no
// command runner still has a filesystem this can look at.
func nvidiaProprietaryDriverInUse(env Env) bool {
	for _, marker := range []string{"/proc/driver/nvidia/version", "/usr/bin/nvidia-smi"} {
		if _, err := os.Stat(env.Path(marker)); err == nil {
			return true
		}
	}
	return false
}

const initramfsModulesPath = "/etc/initramfs-tools/modules"

// nvidiaModules is the set the proprietary driver's own early kernel mode
// setting needs present in the initramfs, in the order NVIDIA's own and
// Arch's documented working configurations list them. nvidia_uvm was
// missing from an earlier version of this list; both references name it.
var nvidiaModules = []string{"nvidia", "nvidia_modeset", "nvidia_uvm", "nvidia_drm"}

// ensureNvidiaModulesInInitramfs is the other half of nvidia-drm.modeset=1 on
// the kernel command line: mode setting has nothing to turn on early if the
// driver itself is not in the initramfs to begin with.
func ensureNvidiaModulesInInitramfs(env Env) (changed bool, err error) {
	if !nvidiaProprietaryDriverInUse(env) {
		return false, nil
	}
	return addModulesToInitramfs(env, nvidiaModules)
}

const nvidiaModprobePath = "/etc/modprobe.d/odm-nvidia-drm.conf"

// nvidiaModprobeConf sets the driver's own module parameters where modprobe
// itself reads them, rather than relying only on the kernel command line.
// mkinitramfs copies /etc/modprobe.d/*.conf into the initramfs, so these
// apply to the modprobe that runs there — which is the one that matters,
// since that is where the driver first loads. fbdev=1 is what makes
// nvidia-drm provide /dev/fb0 itself instead of leaving Plymouth to find
// an efifb that nvidia has already evicted.
//
// The nouveau lines are the important half. nouveau is the in-tree driver
// for the same hardware, and it cannot coexist with the proprietary one:
// its probe calls drm_aperture_remove_conflicting_pci_framebuffers() before
// it does anything else, so it evicts simpledrm/efifb from the display, and
// on hardware it cannot actually drive (an Ampere card with no firmware for
// it) it then fails — leaving no working DRM device at all for the rest of
// early boot. Confirmed live as the reason nothing rendered across four
// consecutive attempts at this: an earlier version of this file listed
// nouveau unconditionally in the initramfs module list, including on
// machines running the proprietary driver, which poisoned every one of
// those tests regardless of what else changed.
const nvidiaModprobeConf = Header + `options nvidia-drm modeset=1 fbdev=1
blacklist nouveau
options nouveau modeset=0
`

func ensureNvidiaModprobeConf(env Env) (changed bool, err error) {
	if !nvidiaProprietaryDriverInUse(env) {
		return false, nil
	}
	existing, err := os.ReadFile(env.Path(nvidiaModprobePath))
	if err == nil && string(existing) == nvidiaModprobeConf {
		return false, nil
	}
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	if err := env.WriteFile(nvidiaModprobePath, nvidiaModprobeConf, 0o644, "root", "root"); err != nil {
		return false, err
	}
	return true, nil
}

// openSourceKmsModules gives Plymouth something to draw on for early Kernel
// Mode Setting on the open-source drivers, the non-nvidia counterpart to
// ensureNvidiaModulesInInitramfs above. Each one is small enough that
// listing it costs nothing on hardware that does not have it.
//
// nouveau is the exception, and is deliberately not in this list: it is the
// in-tree driver for the same hardware the proprietary NVIDIA driver
// claims, and the two cannot coexist. Listing it here unconditionally —
// which an earlier version of this file did — force-loads it in the
// initramfs even on machines running the proprietary driver, where a
// modprobe blacklist does not stop it (a blacklist only blocks automatic
// loading by alias; initramfs-tools runs an explicit modprobe for every
// name in its own modules file). Its probe then evicts simpledrm/efifb
// from the display before failing on hardware it cannot drive, leaving
// nothing for Plymouth to render on at all. Confirmed live as the reason
// four consecutive attempts at this setting rendered nothing, each of
// which changed some other variable while this one quietly poisoned the
// result. ensureOpenSourceKmsModulesInInitramfs below decides it per
// machine instead, and removes a nouveau line an earlier agent wrote.
//
// An earlier version of this instead widened
// /etc/initramfs-tools/initramfs.conf's MODULES= setting to "most",
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
// was, the same bounded, one-file mechanism addModulesToInitramfs already
// uses safely below.
var openSourceKmsModules = []string{"amdgpu", "i915", "radeon"}

// ensureOpenSourceKmsModulesInInitramfs also takes nouveau back off a
// machine that should not have it. Every version of this before now only
// ever appended to the modules file and never removed anything, so a
// machine that was given the nouveau line by an earlier agent keeps it
// through every later rebuild unless something actually deletes it —
// which is why simply dropping it from the list above is not enough on
// its own to fix a machine already running.
func ensureOpenSourceKmsModulesInInitramfs(env Env) (changed bool, err error) {
	added, err := addModulesToInitramfs(env, openSourceKmsModules)
	if err != nil {
		return added, err
	}
	if !nvidiaProprietaryDriverInUse(env) {
		nouveauAdded, err := addModulesToInitramfs(env, []string{"nouveau"})
		return added || nouveauAdded, err
	}
	removed, err := removeModulesFromInitramfs(env, []string{"nouveau"})
	return added || removed, err
}

// removeModulesFromInitramfs deletes a module's own line from the file
// addModulesToInitramfs writes, leaving every other line (including an
// operator's own) exactly as it found it.
func removeModulesFromInitramfs(env Env, modules []string) (changed bool, err error) {
	existing, err := os.ReadFile(env.Path(initramfsModulesPath))
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	drop := map[string]bool{}
	for _, module := range modules {
		drop[module] = true
	}

	var kept []string
	for _, line := range strings.Split(string(existing), "\n") {
		if drop[strings.TrimSpace(line)] {
			changed = true
			continue
		}
		kept = append(kept, line)
	}
	if !changed {
		return false, nil
	}
	if err := env.WriteFile(initramfsModulesPath, strings.Join(kept, "\n"), 0o644, "root", "root"); err != nil {
		return false, err
	}
	return true, nil
}

// storageModules covers real disk hardware and every common virtualised
// disk transport, unconditionally — the display-driver lists above are
// gated on the specific hardware being detected, but a real incident
// (documented in CLAUDE.md) shipped exactly that kind of narrow, detected
// list for storage too, and it went wrong: the assumption that
// MODULES=dep's own auto-detection could be trusted to include whatever
// this specific machine's root filesystem needed was the same "trust the
// tool" mistake this project's own rules now explicitly forbid for
// anything boot-critical, just aimed at a different setting than the one
// that failed the first time. Tried, in order, against this project's own
// domain controller and file server: an LVM logical volume on a virtio-scsi
// disk needed both sd_mod and virtio_scsi, neither of which a name like
// "the NVMe one" would have predicted — which is exactly why this is a
// fixed, generous list rather than another attempt to detect the right
// answer per machine. Every module here is small; listing one this
// particular machine does not need costs a few tens of kilobytes and is
// skipped harmlessly by update-initramfs, the same as the display drivers
// above already do on hardware that does not have them.
var storageModules = []string{
	"nvme", "nvme_core",
	"ahci", "sd_mod", "sr_mod",
	"virtio_blk", "virtio_scsi", "virtio_pci",
	"mmc_block", "sdhci", "sdhci_pci",
	"usb_storage", "uas", "xhci_hcd", "ehci_hcd",
}

func ensureStorageModulesInInitramfs(env Env) (changed bool, err error) {
	return addModulesToInitramfs(env, storageModules)
}

// inputModules covers keyboard input at the rescue-shell stage, not just
// finding root — confirmed necessary live: a machine that dropped to an
// "(initramfs)" prompt during this feature's own debugging had a keyboard
// that did not respond there, on the very same rebuilt initramfs. An
// operator locked out of typing at the one prompt meant to let them
// diagnose a bad boot is left with no recourse at all short of another
// full rescue-media session — the same category of "no way back" CLAUDE.md
// already treats as unacceptable for this class of setting, just for input
// instead of storage.
var inputModules = []string{
	"hid", "usbhid", "hid_generic",
	"i8042", "atkbd",
}

func ensureInputModulesInInitramfs(env Env) (changed bool, err error) {
	return addModulesToInitramfs(env, inputModules)
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

// initrdBackupPath holds a copy of the currently-running kernel's initrd,
// taken immediately before a rebuild and removed once a rebuild is confirmed
// good. Kept under /var/lib/odm rather than /boot itself: a partition
// already tight enough to matter should not carry a second copy of its own
// biggest file, and a backup that lived in the exact directory a bad rebuild
// might fill up would not be a backup at all.
const initrdBackupPath = "/var/lib/odm/initrd-backup.img"

// rebuildInitramfsSafely is the second line of defense after
// sufficientBootSpace above: that check rules out the one specific cause
// already confirmed live (this file's own history), but nothing about
// initramfs generation guarantees a good result for every possible reason a
// rebuild can go wrong — a killed process, a bad package, disk pressure from
// something else entirely. The running kernel's own initrd is the one file
// that must never end up broken, since it is what has to work on the very
// next boot: backed up before the rebuild, the new one is verified with the
// same tool a real login-vs-rescue-shell distinction depends on
// (lsinitramfs, already this project's own documented way to check one:
// Wiki → Troubleshooting → Boot splash), and restored immediately if that
// check fails, rather than ever leaving a machine to find out at its next
// boot. A rebuild that had to be restored is reported as failed — the
// splash setting did not take effect — never as succeeded with an asterisk.
//
// The rebuild itself runs Unsandboxed. odm-agent.service sets
// ProtectKernelModules=true (deliberately — it also removes CAP_SYS_MODULE
// from a process that has no business loading one), and that hardening is
// inherited by anything this service starts directly, hiding
// /usr/lib/modules from it. update-initramfs, run as a direct child, could
// not see the module files at all to copy them in — the module list in
// this file was always correct, but every module named in it was silently
// missing from the actual rebuilt archive regardless, since the tool doing
// the copying could not read its own source directory. lsinitramfs still
// reported the result as a structurally valid archive, since a cpio
// archive missing files it should have had is not itself a corrupt one —
// which is exactly how this passed validation and still could not find a
// root filesystem, or accept keyboard input, at the next real boot. A
// manual rebuild from rescue media, with no such sandbox, always produced
// a working one; only a rebuild triggered by the agent itself was ever
// affected.
func rebuildInitramfsSafely(ctx context.Context, env Env) policy.Result {
	backedUp, current := backupCurrentInitrd(ctx, env)

	out, err := Unsandboxed(ctx, env, "plymouth-set-default-theme", splashTheme, "-R")
	if err != nil {
		// -R rebuilds the initramfs with this theme baked in; without it the
		// theme is set for next time update-initramfs runs for some other
		// reason, and the machine boots on whatever theme it already had.
		return policy.Result{
			Setting: "grub:splash", Status: "failed",
			Reason: fmt.Sprintf("setting the boot splash theme: %v: %s", err, lastLine(out)),
		}
	}

	if !backedUp {
		return policy.Ok("grub:splash")
	}
	if valid, checkErr := initrdIsValid(ctx, env, current); checkErr == nil && !valid {
		if restoreErr := restoreInitrd(env, current); restoreErr != nil {
			return policy.Fail("grub:splash", fmt.Errorf(
				"the rebuilt initramfs failed validation and could not be restored from backup (%w) — "+
					"this machine may not boot; rescue it before the next reboot", restoreErr))
		}
		return policy.Fail("grub:splash", fmt.Errorf(
			"the rebuilt initramfs failed validation; restored the previous working image, nothing changed"))
	}
	_ = os.Remove(env.Path(initrdBackupPath))
	return policy.Ok("grub:splash")
}

// backupCurrentInitrd preserves the running kernel's own initrd before a
// rebuild touches it. Reports false with nothing backed up on a machine
// that has no such file yet (the very first time the splash is turned on)
// — there being nothing to protect is not itself a failure.
func backupCurrentInitrd(ctx context.Context, env Env) (backedUp bool, currentPath string) {
	kernelVersion, err := env.Run.Run(ctx, "uname", "-r")
	if err != nil {
		return false, ""
	}
	currentPath = "/boot/initrd.img-" + strings.TrimSpace(kernelVersion)
	data, err := os.ReadFile(env.Path(currentPath))
	if err != nil {
		return false, currentPath
	}
	if err := env.WriteFile(initrdBackupPath, string(data), 0o600, "root", "root"); err != nil {
		return false, currentPath
	}
	return true, currentPath
}

// initrdIsValid runs the same tool this project's own troubleshooting docs
// already point an operator at to inspect an initrd's contents — a
// truncated or otherwise corrupt archive fails to list, which is exactly
// the failure mode a /boot space exhaustion (or any other rebuild problem)
// produces.
func initrdIsValid(ctx context.Context, env Env, path string) (bool, error) {
	if _, err := os.Stat(env.Path(path)); err != nil {
		return false, err
	}
	_, err := env.Run.Run(ctx, "lsinitramfs", env.Path(path))
	return err == nil, nil
}

// restoreInitrd puts the pre-rebuild backup back in place of a rebuild that
// failed validation, so a bad rebuild never reaches the next boot.
func restoreInitrd(env Env, path string) error {
	data, err := os.ReadFile(env.Path(initrdBackupPath))
	if err != nil {
		return err
	}
	if err := env.WriteFile(path, string(data), 0o644, "root", "root"); err != nil {
		return err
	}
	return os.Remove(env.Path(initrdBackupPath))
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
