package apply

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

// writePlymouthInstalledMarker makes plymouthInstalled report true, so a
// test can exercise what happens once the package is there without also
// exercising the apt-get install path every time.
func writePlymouthInstalledMarker(t *testing.T, env Env) {
	t.Helper()
	full := env.Path("/usr/sbin/plymouth-set-default-theme")
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestBootSplashInstallsPlymouthWhenMissing(t *testing.T) {
	env, runner := testEnv(t)
	// No canned theme output: a machine that never had plymouth has no
	// default theme to report, which is exactly what should be treated as
	// "not already spinner" and trigger the first-time rebuild below.

	results := applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if !runner.ran("apt-get", "install") {
		t.Errorf("plymouth was not installed: %v", runner.commands)
	}
	if !runner.ran("plymouth-set-default-theme", splashTheme+" -R") {
		t.Errorf("the spinner theme was not set: %v", runner.commands)
	}
	if len(results) == 0 || results[0].Status != "success" {
		t.Errorf("not reported as applied: %+v", results)
	}
}

func TestBootSplashSkipsInstallWhenAlreadyPresent(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = "text\n" // a different theme

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if runner.ran("apt-get", "") {
		t.Errorf("apt-get ran even though plymouth was already installed: %v", runner.commands)
	}
	if !runner.ran("plymouth-set-default-theme", splashTheme+" -R") {
		t.Error("the theme was not changed away from the machine's existing one")
	}
}

// The initramfs rebuild -R triggers is seconds long, and nothing about an
// unchanged policy should pay that cost on every fifteen-minute poll.
func TestBootSplashDoesNotRebuildWhenNothingChanged(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	// First pass: the theme's own signature has never been recorded, so this
	// establishes the baseline and is expected to rebuild once.
	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)
	runner.commands = nil

	results := applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if runner.ran("plymouth-set-default-theme", "-R") {
		t.Errorf("rebuilt the initramfs for a theme that was already correct: %v", runner.commands)
	}
	if len(results) == 0 || results[0].Status != "success" {
		t.Errorf("an already-correct theme was not reported as applied: %+v", results)
	}
}

var onePixelPNG = base64.StdEncoding.EncodeToString([]byte{
	0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 'f', 'a', 'k', 'e', ' ', 'p', 'n', 'g',
})

func TestBootSplashWatermarkIsWrittenOnceAndDedupedAfter(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true, SplashImage: onePixelPNG}, env)
	if !runner.ran("plymouth-set-default-theme", "-R") {
		t.Fatal("a new logo did not rebuild the initramfs")
	}
	if _, err := os.Stat(env.Path(splashWatermarkPath)); err != nil {
		t.Fatalf("the logo was not written: %v", err)
	}
	runner.commands = nil

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true, SplashImage: onePixelPNG}, env)
	if runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("the same logo rebuilt the initramfs a second time")
	}
}

func TestBootSplashWatermarkIsRemovedWhenCleared(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true, SplashImage: onePixelPNG}, env)
	runner.commands = nil

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if _, err := os.Stat(env.Path(splashWatermarkPath)); err == nil {
		t.Error("the logo file was left behind after the policy cleared it")
	}
	if !runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("removing the logo did not rebuild the initramfs")
	}
}

func TestBootSplashBackgroundIsWrittenOnceAndDedupedAfter(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true, SplashBackground: onePixelPNG}, env)
	if !runner.ran("plymouth-set-default-theme", "-R") {
		t.Fatal("a new background did not rebuild the initramfs")
	}
	if _, err := os.Stat(env.Path(splashBackgroundPath)); err != nil {
		t.Fatalf("the background was not written: %v", err)
	}
	runner.commands = nil

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true, SplashBackground: onePixelPNG}, env)
	if runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("the same background rebuilt the initramfs a second time")
	}
}

func TestBootSplashBackgroundIsRemovedWhenCleared(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true, SplashBackground: onePixelPNG}, env)
	runner.commands = nil

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if _, err := os.Stat(env.Path(splashBackgroundPath)); err == nil {
		t.Error("the background file was left behind after the policy cleared it")
	}
	if !runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("removing the background did not rebuild the initramfs")
	}
}

// The theme itself — the script, its descriptor and every spin frame — is
// what actually renders the splash; a machine that never received these
// files would boot on Plymouth's fallback rather than this theme at all.
func TestBootSplashWritesEveryThemeFile(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	names, err := splashAssetNames()
	if err != nil {
		t.Fatal(err)
	}
	if len(names) == 0 {
		t.Fatal("the embedded theme carries no files to check")
	}
	for _, name := range names {
		if _, err := os.Stat(env.Path(splashThemeDir + "/" + name)); err != nil {
			t.Errorf("%s was not written to the theme directory: %v", name, err)
		}
	}
	if !runner.ran("plymouth-set-default-theme", splashTheme+" -R") {
		t.Error("the theme was never set as the machine's default")
	}
}

// The message unit is written once and never touched again; only the file
// it reads changes, so setting, changing or clearing a message is never
// more than a text file write.
func TestBootSplashMessageUnitIsWrittenOnceThenOnlyTheTextChanges(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true, SplashMessage: "Starting up"}, env)
	if !runner.ran("systemctl", "enable odm-boot-message.service") {
		t.Fatal("the boot-message unit was never enabled")
	}
	if got := read(t, env, splashMessagePath); got != "Starting up\n" {
		t.Errorf("message file = %q", got)
	}
	runner.commands = nil

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true, SplashMessage: "Almost there"}, env)
	if runner.ran("systemctl", "") {
		t.Errorf("changing the message touched systemd again: %v", runner.commands)
	}
	if got := read(t, env, splashMessagePath); got != "Almost there\n" {
		t.Errorf("message file = %q", got)
	}

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)
	if _, err := os.Stat(env.Path(splashMessagePath)); err == nil {
		t.Error("clearing the message left the file behind")
	}
	if _, err := os.Stat(env.Path(splashUnitPath)); err != nil {
		t.Error("the unit itself was removed along with the message; it should stay installed")
	}
}

func TestBootSplashOffRemovesTheMessageAndTouchesNothingElse(t *testing.T) {
	env, runner := testEnv(t)
	if err := env.WriteFile(splashMessagePath, "leftover\n", 0o644, "root", "root"); err != nil {
		t.Fatal(err)
	}

	results := applyBootSplash(context.Background(), &policy.Grub{BootSplash: false}, env)

	if len(runner.commands) != 0 {
		t.Errorf("turning the splash off ran commands: %v", runner.commands)
	}
	if _, err := os.Stat(env.Path(splashMessagePath)); err == nil {
		t.Error("the leftover message file was not cleaned up")
	}
	for _, r := range results {
		if r.Status == "failed" {
			t.Errorf("unexpected failure: %+v", r)
		}
	}
}

// applyBootSplashTwice runs the setting the way the agent really does: a
// fresh State per pass, and the previous pass's State pruned against the new
// one at the end — which is the only arrangement in which the bug this
// guards against can appear at all. Returns the paths the second pass
// deleted.
func applyBootSplashTwice(t *testing.T, env Env, g *policy.Grub) []string {
	t.Helper()
	applyBootSplash(context.Background(), g, env)

	previous := env.State
	env.State = NewState()
	applyBootSplash(context.Background(), g, env)
	return env.Prune(previous)
}

// A second apply of an unchanged policy must not delete what the first one
// put there. Every file below is written by an applier that compares before
// it writes and returns early when the contents are already right, so before
// Env.Keep existed the second pass claimed none of them and the prune at the
// end of it removed the lot — on a live client, an apply that reported
// success took out the machine's plymouth configuration, its storage and
// input module list, and the pictures the operator had uploaded, and said
// nothing about it. Latent since 0.10.3.
func TestASecondApplyDeletesNothingItStillWants(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	removed := applyBootSplashTwice(t, env, &policy.Grub{
		BootSplash:       true,
		SplashImage:      onePixelPNG,
		SplashBackground: onePixelPNG,
		SplashMessage:    "Loading Operating System...",
	})

	if len(removed) != 0 {
		t.Errorf("a second apply of an unchanged policy deleted %v", removed)
	}
	for _, path := range []string{
		plymouthConfPath,
		initramfsModulesPath,
		nvidiaModprobePath,
		splashWatermarkPath,
		splashBackgroundPath,
		splashAssetSumPath,
		splashMessagePath,
		splashUnitPath,
	} {
		if _, err := os.Stat(env.Path(path)); err != nil {
			t.Errorf("%s did not survive a second apply: %v", path, err)
		}
	}
}

// The same two passes must also not quietly undo the work of the first: a
// prune that deletes /etc/initramfs-tools/modules takes the storage and
// input drivers out with it, and the machine that boots next has no way to
// find its root filesystem and no keyboard at the rescue prompt it lands in.
func TestASecondApplyKeepsTheModulesThatLetTheMachineBoot(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	applyBootSplashTwice(t, env, &policy.Grub{BootSplash: true})

	// By line, not by substring: "hid" is inside "usbhid", and a check that
	// cannot tell those apart would pass with the line it is looking for
	// gone.
	listed := map[string]bool{}
	for _, line := range strings.Split(read(t, env, initramfsModulesPath), "\n") {
		listed[strings.TrimSpace(line)] = true
	}
	for _, module := range append(append([]string{}, storageModules...), inputModules...) {
		if !listed[module] {
			t.Errorf("%s was lost from the initramfs module list", module)
		}
	}
}

// A machine upgraded from an agent that did claim these carries that claim
// in the state file already on its disk, and a stale claim is enough to
// delete the file exactly once — on the very upgrade meant to fix this.
func TestPruneNeverDeletesASystemFileAnOlderAgentClaimed(t *testing.T) {
	env, _ := testEnv(t)
	write(t, env, plymouthConfPath, "[Daemon]\nTheme=odm-boot\n"+plymouthDeviceTimeout+"\n")
	write(t, env, initramfsModulesPath, "nvme\nxhci_hcd\n")

	stale := NewState()
	stale.Owned[plymouthConfPath] = true
	stale.Owned[initramfsModulesPath] = true

	if removed := env.Prune(stale); len(removed) != 0 {
		t.Errorf("pruned system files an older agent had claimed: %v", removed)
	}
	for _, path := range []string{plymouthConfPath, initramfsModulesPath} {
		if _, err := os.Stat(env.Path(path)); err != nil {
			t.Errorf("%s was deleted on upgrade: %v", path, err)
		}
	}
}

// The most dangerous instance of the same bug. restoreInitrd writes
// /boot/initrd.img-<version> when a rebuild fails validation, which claimed
// the running kernel's initramfs — so the next ordinary refresh, having no
// reason to write it again, deleted it. A machine that no longer boots, out
// of a policy poll that changed nothing.
func TestPruneNeverTouchesBootOrTheWayBack(t *testing.T) {
	env, _ := testEnv(t)
	initrd := "/boot/initrd.img-6.12.107+deb13-amd64"

	if err := env.WriteFile(initrd, "restored from backup", 0o644, "", ""); err != nil {
		t.Fatal(err)
	}
	if env.State.Owned[initrd] {
		t.Error("writing the running kernel's initramfs claimed it for pruning")
	}
	write(t, env, initrdBackupPath, "the pre-rebuild image")

	// Both claimed, as an agent from before this fix would have left them.
	stale := NewState()
	stale.Owned[initrd] = true
	stale.Owned[initrdBackupPath] = true

	if removed := env.Prune(stale); len(removed) != 0 {
		t.Errorf("pruned this machine's ability to boot: %v", removed)
	}
	for _, path := range []string{initrd, initrdBackupPath} {
		if _, err := os.Stat(env.Path(path)); err != nil {
			t.Errorf("%s was deleted: %v", path, err)
		}
	}
}

// Turning the setting off still has to clean up what ODM's own files are:
// the never-prune rule covers the system's files, not ODM's.
func TestPruneStillRemovesOdmsOwnFiles(t *testing.T) {
	env, _ := testEnv(t)
	if err := env.WriteFile(nvidiaModprobePath, nvidiaModprobeConf, 0o644, "root", "root"); err != nil {
		t.Fatal(err)
	}

	previous := env.State
	env.State = NewState()

	if removed := env.Prune(previous); len(removed) != 1 || removed[0] != nvidiaModprobePath {
		t.Errorf("ODM's own file was not cleaned up: %v", removed)
	}
}

// Confirmed live, against real hardware: without nvidia-drm.modeset=1 and
// the driver itself in the initramfs, the proprietary driver never takes
// over kernel mode setting, and Plymouth has nothing to draw on for the
// whole of early boot — the console stays on the plain firmware framebuffer
// showing kernel and systemd text regardless of how correct the theme is.
func writeNvidiaMarker(t *testing.T, env Env) {
	t.Helper()
	full := env.Path("/usr/bin/nvidia-smi")
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

// Both parameters together, the configuration NVIDIA's own documentation
// and every independent working write-up for this combination specify.
func TestGrubAddsNvidiaModesetAndFbdev(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)

	applyGrub(context.Background(), policy.Settings{
		Grub: &policy.Grub{BootSplash: true},
	}, env)

	body := read(t, env, grubConfPath)
	for _, want := range []string{
		"nvidia-drm.modeset=1",
		"nvidia-drm.fbdev=1",
		"GRUB_GFXMODE=" + grubGfxModes,
		"GRUB_GFXPAYLOAD_LINUX=keep",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("%s missing with the proprietary driver present:\n%s", want, body)
		}
	}
}

// nouveau cannot coexist with the proprietary driver, and a blacklist does
// not stop an explicit modprobe of a name in the initramfs modules file —
// so the name must not be in that file at all. Confirmed live as the cause
// of four consecutive attempts at this setting rendering nothing.
func TestNouveauIsNeverInTheInitramfsWithTheProprietaryDriver(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, initramfsModulesPath)
	for _, line := range strings.Split(body, "\n") {
		if strings.TrimSpace(line) == "nouveau" {
			t.Errorf("nouveau was force-loaded alongside the proprietary driver:\n%s", body)
		}
	}
}

// A machine given the nouveau line by an earlier agent keeps it through
// every later rebuild unless something actually deletes it — dropping it
// from the list is not enough on its own to fix a machine already running.
func TestNouveauAlreadyWrittenByAnEarlierAgentIsRemoved(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)
	if err := env.WriteFile(
		initramfsModulesPath, "# comment\nnouveau\namdgpu\n", 0o644, "root", "root",
	); err != nil {
		t.Fatal(err)
	}

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, initramfsModulesPath)
	for _, line := range strings.Split(body, "\n") {
		if strings.TrimSpace(line) == "nouveau" {
			t.Errorf("a nouveau line written by an earlier agent survived:\n%s", body)
		}
	}
	if !strings.Contains(body, "# comment") || !strings.Contains(body, "amdgpu") {
		t.Errorf("removing nouveau disturbed other lines:\n%s", body)
	}
}

// Without the proprietary driver, nouveau is the correct driver for the
// hardware and stays listed.
func TestNouveauIsKeptWithoutTheProprietaryDriver(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, initramfsModulesPath)
	if !strings.Contains(body, "nouveau") {
		t.Errorf("nouveau missing on a machine with no proprietary driver:\n%s", body)
	}
}

// The module options modprobe itself reads, copied into the initramfs by
// mkinitramfs — the path that actually applies when the module is loaded
// by name there, rather than only the kernel command line.
func TestNvidiaModprobeOptionsAreWritten(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, nvidiaModprobePath)
	for _, want := range []string{
		"options nvidia-drm modeset=1 fbdev=1",
		"blacklist nouveau",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("%q missing from %s:\n%s", want, nvidiaModprobePath, body)
		}
	}
	if !runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("writing the module options did not rebuild the initramfs")
	}
}

func TestNvidiaModprobeOptionsAreNotWrittenWithoutTheDriver(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if _, err := os.Stat(env.Path(nvidiaModprobePath)); err == nil {
		t.Error("nvidia module options written on a machine with no nvidia driver")
	}
}

func TestGrubNeverAddsNvidiaModesetWithoutTheProprietaryDriver(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyGrub(context.Background(), policy.Settings{
		Grub: &policy.Grub{BootSplash: true},
	}, env)

	body := read(t, env, grubConfPath)
	if strings.Contains(body, "nvidia") {
		t.Errorf("an nvidia-specific parameter was added on a machine with no nvidia driver:\n%s", body)
	}
}

// The proprietary driver is kept out of the initramfs, and taken back out
// of a machine an earlier agent put it into. Plymouth's own debug log is
// what settled this: with those modules present the only devices it ever
// sees are nvidia's render node (no modesetting, cannot work) and a card
// node that arrives ten seconds into boot, and nvidia taking the display
// is what removes the one framebuffer Plymouth can actually draw on.
func TestNvidiaModulesAreRemovedFromTheInitramfs(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)
	if err := env.WriteFile(
		initramfsModulesPath, "# comment\nnvidia\nnvidia_modeset\nnvidia_uvm\nnvidia_drm\nnvme\n",
		0o644, "root", "root",
	); err != nil {
		t.Fatal(err)
	}

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, initramfsModulesPath)
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "nvidia") {
			t.Errorf("%s left in the initramfs module list:\n%s", trimmed, body)
		}
	}
	if !strings.Contains(body, "# comment") || !strings.Contains(body, "nvme") {
		t.Errorf("removing the nvidia modules disturbed other lines:\n%s", body)
	}
	if !runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("removing the nvidia modules did not rebuild the initramfs")
	}
}

// Plymouth will not claim a legacy /dev/fb framebuffer until DeviceTimeout
// has elapsed (eight seconds by default), and on this hardware that
// framebuffer is the only device it can ever draw on.
func TestPlymouthDeviceTimeoutIsShortenedWithTheProprietaryDriver(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)
	if err := env.WriteFile(
		plymouthConfPath, "# comment\n[Daemon]\nTheme=odm-boot\n", 0o644, "root", "root",
	); err != nil {
		t.Fatal(err)
	}

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, plymouthConfPath)
	if !strings.Contains(body, plymouthDeviceTimeout+"\n") {
		t.Errorf("%s missing:\n%s", plymouthDeviceTimeout, body)
	}
	if !strings.Contains(body, "Theme=odm-boot") {
		t.Errorf("the theme line was disturbed:\n%s", body)
	}
	if strings.Count(body, "DeviceTimeout=") != 1 {
		t.Errorf("DeviceTimeout written more than once:\n%s", body)
	}
}

func TestPlymouthDeviceTimeoutIsNotRewrittenOnceCorrect(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)
	runner.commands = nil

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("an already-correct DeviceTimeout triggered another rebuild")
	}
}

// Elsewhere the wait is doing its job — a machine whose GPU driver is
// merely slow to probe should not be downgraded a moment before its real
// device appears.
func TestPlymouthDeviceTimeoutIsLeftAloneWithoutTheProprietaryDriver(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if _, err := os.Stat(env.Path(plymouthConfPath)); err == nil {
		body := read(t, env, plymouthConfPath)
		if strings.Contains(body, "DeviceTimeout") {
			t.Errorf("DeviceTimeout written on a machine with no nvidia driver:\n%s", body)
		}
	}
}

func TestNvidiaModulesAreNotAddedWithoutTheProprietaryDriver(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, initramfsModulesPath)
	for _, module := range []string{"nvidia", "nvidia_modeset", "nvidia_drm"} {
		if strings.Contains(body, module) {
			t.Errorf("%s added on a machine with no nvidia driver:\n%s", module, body)
		}
	}
}

// The open-source KMS drivers are named explicitly into
// /etc/initramfs-tools/modules — the same bounded, one-file mechanism the
// nvidia modules already use — rather than by widening MODULES= to "most",
// which used to pull every module for every class of hardware into the
// initramfs and could exhaust a small /boot partition. See the comment on
// openSourceKmsModules in bootsplash.go for why that regressed to hard-locked
// machines in practice.
func TestOpenSourceKmsModulesAreAddedToTheInitramfs(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, initramfsModulesPath)
	for _, module := range openSourceKmsModules {
		if !strings.Contains(body, module) {
			t.Errorf("%s missing from initramfs modules:\n%s", module, body)
		}
	}
	if strings.Contains(body, "MODULES=most") {
		t.Errorf("MODULES was widened to most, which this now avoids:\n%s", body)
	}
	if !runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("adding the kms modules did not rebuild the initramfs")
	}
}

// Storage drivers are force-included unconditionally, unlike the display
// drivers above — the incident this whole file now guards against was a
// narrow, "detected" module list for exactly this category, and it missed
// what a real machine actually needed. See the comment on storageModules.
func TestStorageModulesAreAddedToTheInitramfsUnconditionally(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, initramfsModulesPath)
	for _, module := range storageModules {
		if !strings.Contains(body, module) {
			t.Errorf("%s missing from initramfs modules:\n%s", module, body)
		}
	}
	if !runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("adding the storage modules did not rebuild the initramfs")
	}
}

func TestStorageModulesAlreadyPresentDoNotForceARebuild(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)
	runner.commands = nil

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("already-present storage modules triggered a rebuild")
	}
}

// Keyboard input at the rescue-shell stage matters as much as finding root
// does — an operator locked out of typing at an "(initramfs)" prompt has no
// recourse short of another full rescue-media session. Confirmed necessary
// live, on the very machine this file's own storage-module fix was tested
// against.
func TestInputModulesAreAddedToTheInitramfsUnconditionally(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, initramfsModulesPath)
	for _, module := range inputModules {
		if !strings.Contains(body, module) {
			t.Errorf("%s missing from initramfs modules:\n%s", module, body)
		}
	}
	if !runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("adding the input modules did not rebuild the initramfs")
	}
}

func TestInputModulesAlreadyPresentDoNotForceARebuild(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)
	runner.commands = nil

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("already-present input modules triggered a rebuild")
	}
}

func TestOpenSourceKmsModulesAlreadyPresentDoNotForceARebuild(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	// First pass establishes every baseline, including the modules file.
	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)
	runner.commands = nil

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("already-present kms modules triggered a rebuild")
	}
}

// A rebuild that runs /boot out of space can leave a truncated initrd behind
// — a machine that never mounts its root filesystem again. This must refuse
// to start the rebuild rather than find that out the hard way.
func TestBootSplashRefusesToRebuildWithoutEnoughBootSpace(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	if err := os.MkdirAll(env.Path("/boot"), 0o755); err != nil {
		t.Fatal(err)
	}

	results := applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	// The test environment's real filesystem has plenty of room, so this
	// only exercises that the guard runs and does not itself misfire; the
	// low-space branch is exercised in TestSufficientBootSpace below.
	if runner.ran("plymouth-set-default-theme", "-R") == false {
		t.Error("a machine with real free space did not rebuild")
	}
	for _, r := range results {
		if r.Status == "failed" {
			t.Errorf("unexpected failure with real free space: %+v", r)
		}
	}
}

func TestSufficientBootSpace(t *testing.T) {
	env, _ := testEnv(t)
	if err := os.MkdirAll(env.Path("/boot"), 0o755); err != nil {
		t.Fatal(err)
	}

	ok, err := sufficientBootSpace(env)
	if err != nil {
		t.Fatalf("unexpected error statting a real directory: %v", err)
	}
	if !ok {
		t.Error("the test filesystem should have far more than the minimum free")
	}
}

// The second line of defense (see the comment on rebuildInitramfsSafely in
// bootsplash.go): even a rebuild that gets this far must not be trusted
// blind. A validation failure must restore the last-known-good initrd and
// report the setting as failed, never as applied.
func TestRebuildRestoresThePreviousInitrdWhenValidationFails(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["uname"] = "6.1.0-test\n"
	runner.fail["lsinitramfs"] = "cpio: premature end of file"
	currentInitrd := "/boot/initrd.img-6.1.0-test"
	if err := env.WriteFile(currentInitrd, "good initrd bytes", 0o644, "root", "root"); err != nil {
		t.Fatal(err)
	}

	results := applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	found := false
	for _, r := range results {
		if r.Setting != "grub:splash" {
			continue
		}
		found = true
		if r.Status != "failed" {
			t.Errorf("a rebuild that failed validation must not report success: %+v", r)
		}
		if !strings.Contains(r.Reason, "restored") {
			t.Errorf("the failure reason should say the previous image was restored: %+v", r)
		}
	}
	if !found {
		t.Fatal("no grub:splash result reported")
	}
	if _, err := os.Stat(env.Path(initrdBackupPath)); err == nil {
		t.Error("the backup should be cleaned up once it has been restored")
	}
}

func TestRebuildKeepsTheNewInitrdWhenValidationPasses(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["uname"] = "6.1.0-test\n"
	currentInitrd := "/boot/initrd.img-6.1.0-test"
	if err := env.WriteFile(currentInitrd, "good initrd bytes", 0o644, "root", "root"); err != nil {
		t.Fatal(err)
	}

	results := applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	for _, r := range results {
		if r.Setting == "grub:splash" && r.Status != "success" {
			t.Errorf("a rebuild that passed validation should report success: %+v", r)
		}
	}
	if !runner.ran("lsinitramfs", "") {
		t.Error("the rebuilt initrd was never validated")
	}
	if _, err := os.Stat(env.Path(initrdBackupPath)); err == nil {
		t.Error("the backup should be cleaned up once the rebuild is confirmed good")
	}
}

// A machine with no existing initrd for the running kernel yet (the very
// first time the splash is turned on) has nothing to protect — this must
// not be treated as a failure to back up.
func TestRebuildSkipsValidationWhenThereIsNothingToRestore(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["uname"] = "6.1.0-test\n"
	runner.fail["lsinitramfs"] = "should never be called"

	results := applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	for _, r := range results {
		if r.Setting == "grub:splash" && r.Status != "success" {
			t.Errorf("nothing to protect should not block the first-ever rebuild: %+v", r)
		}
	}
	if runner.ran("lsinitramfs", "") {
		t.Error("validation ran against a kernel that never had an initrd to protect")
	}
}

// restoreInitrd is exercised directly, separately from the orchestration
// above, since the fake command runner cannot simulate plymouth actually
// overwriting the file — this proves the byte-for-byte copy-back itself.
func TestRestoreInitrdCopiesTheBackupContentBack(t *testing.T) {
	env, _ := testEnv(t)
	currentPath := "/boot/initrd.img-6.1.0-test"
	if err := env.WriteFile(currentPath, "corrupt truncated bytes", 0o644, "root", "root"); err != nil {
		t.Fatal(err)
	}
	if err := env.WriteFile(initrdBackupPath, "good initrd bytes", 0o600, "root", "root"); err != nil {
		t.Fatal(err)
	}

	if err := restoreInitrd(env, currentPath); err != nil {
		t.Fatalf("restoreInitrd: %v", err)
	}

	if got := read(t, env, currentPath); got != "good initrd bytes" {
		t.Errorf("restored content = %q, want the backup's content", got)
	}
	if _, err := os.Stat(env.Path(initrdBackupPath)); err == nil {
		t.Error("the backup file should be removed once restored")
	}
}

func TestInitramfsModulesFileMissingIsNotAnError(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	results := applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	for _, r := range results {
		if r.Status == "failed" {
			t.Errorf("a machine with no initramfs-tools config should not fail: %+v", r)
		}
	}
}

// A menu GRUB will actually show (see the two-second floor in grub.go) is
// only a real way back if there is a second kernel in it to choose. This is
// reported, not enforced: a single-kernel machine may be a deliberate
// choice, but the operator should see the risk in RSoP either way.
func TestFallbackKernelAdvisoryFiresWithOnlyOneKernel(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	if err := env.WriteFile("/boot/vmlinuz-6.12.107+deb13-amd64", "x", 0o644, "root", "root"); err != nil {
		t.Fatal(err)
	}

	results := applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	found := false
	for _, r := range results {
		if r.Setting == "grub:splash_fallback" {
			found = true
		}
	}
	if !found {
		t.Error("expected an advisory about the missing fallback kernel")
	}
}

func TestFallbackKernelAdvisoryIsQuietWithTwoKernels(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	for _, name := range []string{"vmlinuz-6.12.107+deb13-amd64", "vmlinuz-6.12.94+deb13-amd64"} {
		if err := env.WriteFile("/boot/"+name, "x", 0o644, "root", "root"); err != nil {
			t.Fatal(err)
		}
	}

	results := applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	for _, r := range results {
		if r.Setting == "grub:splash_fallback" {
			t.Errorf("unexpected fallback advisory with two kernels present: %+v", r)
		}
	}
}

// Plymouth arms its device wait with ply_event_loop_watch_for_timeout,
// which begins with assert (seconds > 0.0). 0.10.15 wrote DeviceTimeout=0
// and every boot after it killed plymouthd a millisecond in — twice, once
// in the initramfs and once from the root filesystem — leaving a text
// console and "Result: core-dump" against plymouth-start.service. The
// value is pinned as a positive number here so that nothing can put a zero
// back, whatever the reasoning.
func TestPlymouthDeviceTimeoutIsAPositiveNumber(t *testing.T) {
	_, value, found := strings.Cut(plymouthDeviceTimeout, "=")
	if !found {
		t.Fatalf("%q is not a key=value line", plymouthDeviceTimeout)
	}
	seconds, err := strconv.ParseFloat(value, 64)
	if err != nil {
		t.Fatalf("%q does not parse as a number: %v", value, err)
	}
	if !(seconds > 0) {
		t.Errorf("DeviceTimeout=%v aborts plymouthd: ply-event-loop.c asserts seconds > 0", seconds)
	}
}

// A machine that ran 0.10.15 or 0.10.16 carries the zero on disk and in
// its initramfs. The next apply has to replace it, not treat it as
// already-correct, and rebuild so the initramfs picks the new value up.
func TestPlymouthDeviceTimeoutZeroFromAnEarlierAgentIsReplaced(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"
	write(t, env, plymouthConfPath, "[Daemon]\nTheme=odm-boot\nDeviceTimeout=0\n")

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, plymouthConfPath)
	if strings.Contains(body, "DeviceTimeout=0\n") {
		t.Errorf("the zero that crashes plymouthd was left in place:\n%s", body)
	}
	if !strings.Contains(body, plymouthDeviceTimeout+"\n") {
		t.Errorf("%s not written:\n%s", plymouthDeviceTimeout, body)
	}
	if !runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("replacing the value did not rebuild the initramfs it is baked into")
	}
}

// On the proprietary NVIDIA driver the shutdown splash froze on screen until
// a key was pressed (the driver's own WARN_ON on the display handoff, seen in
// the client's logs for Xorg, gdbus and then plymouthd in turn). The splash
// is for boot; on that driver it stays out of shutdown, and comes back the
// moment the setting is turned off.
func TestTheShutdownSplashIsMaskedOnlyOnTheProprietaryDriverAndOnlyOnce(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)
	if !runner.ran("systemctl", "mask plymouth-poweroff.service plymouth-reboot.service") {
		t.Errorf("the shutdown units were not masked: %v", runner.commands)
	}
	if _, err := os.Stat(env.Path(shutdownSplashMarker)); err != nil {
		t.Error("no record was kept of having masked them, so nothing could ever unmask them")
	}

	runner.commands = nil
	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)
	if runner.ran("systemctl", "mask") {
		t.Error("masked again on a pass where nothing changed")
	}

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: false}, env)
	if !runner.ran("systemctl", "unmask plymouth-poweroff.service") {
		t.Errorf("turning the splash off did not give the shutdown splash back: %v", runner.commands)
	}
	if _, err := os.Stat(env.Path(shutdownSplashMarker)); err == nil {
		t.Error("the record outlived the mask")
	}
}

func TestTheShutdownSplashIsLeftAloneWithoutTheProprietaryDriver(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)
	if runner.ran("systemctl", "mask") || runner.ran("systemctl", "unmask") {
		t.Errorf("touched plymouth's shutdown units on a machine with no nvidia driver: %v", runner.commands)
	}
}

// "Nothing but the splash" is the operator's own choice, off by default,
// because what it hides is what a stuck boot has to say for itself.
func TestSilentBootIsOptInAndHidesEverythingShortOfAPanic(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyGrub(context.Background(), policy.Settings{Grub: &policy.Grub{BootSplash: true}}, env)
	if strings.Contains(read(t, env, grubConfPath), "loglevel=0") {
		t.Error("the splash alone silenced the kernel")
	}

	applyGrub(context.Background(), policy.Settings{
		Grub: &policy.Grub{BootSplash: true, Silent: true},
	}, env)
	body := read(t, env, grubConfPath)
	for _, want := range []string{
		"loglevel=0", "systemd.show_status=false", "rd.systemd.show_status=false",
		"vt.global_cursor_default=0",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("silent boot is missing %s:\n%s", want, body)
		}
	}
	if !strings.Contains(body, "quiet splash") {
		t.Errorf("silent boot dropped the splash itself:\n%s", body)
	}
}
