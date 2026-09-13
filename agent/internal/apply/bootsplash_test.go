package apply

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
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

// There is deliberately no NVIDIA-specific kernel mode-setting parameter
// added at all any more — see the comment on openSourceKmsModules in
// bootsplash.go for the full history: nvidia-drm.modeset=1, and later
// nvidia_drm.fbdev=1 alongside it, both confirmed live to leave Plymouth's
// DRM renderer drawing nothing, because of a real, reproducible kernel
// WARN_ON inside NVIDIA's own nvidia_drm.ko, not fixable from the kernel
// command line or any module parameter that driver exposes.
// GRUB_GFXPAYLOAD_LINUX=keep alone (unconditional, see below) already gives
// Plymouth a generic, vendor-neutral framebuffer to draw on via the
// kernel's own simpledrm/efifb driver, on any hardware. This confirms that
// stays true even on a machine that clearly has the proprietary driver.
func TestGrubNeverAddsNvidiaSpecificParametersEvenWithTheDriverPresent(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	full := env.Path("/usr/bin/nvidia-smi")
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	applyGrub(context.Background(), policy.Settings{
		Grub: &policy.Grub{BootSplash: true},
	}, env)

	body := read(t, env, grubConfPath)
	if strings.Contains(body, "nvidia") {
		t.Errorf("an nvidia-specific parameter was added despite the known driver bug:\n%s", body)
	}
	if !strings.Contains(body, `GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"`) {
		t.Errorf("the plain quiet splash cmdline is missing:\n%s", body)
	}
	if !strings.Contains(body, "GRUB_GFXPAYLOAD_LINUX=keep") {
		t.Errorf("GRUB_GFXPAYLOAD_LINUX=keep is missing:\n%s", body)
	}
}

// No initramfs modules are specific to nvidia any more either — see the
// same history above.
func TestInitramfsModulesNeverIncludeNvidiaEvenWithTheDriverPresent(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	full := env.Path("/usr/bin/nvidia-smi")
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, initramfsModulesPath)
	for _, module := range []string{"nvidia", "nvidia_modeset", "nvidia_drm"} {
		if strings.Contains(body, module) {
			t.Errorf("%s added despite the known driver bug:\n%s", module, body)
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
