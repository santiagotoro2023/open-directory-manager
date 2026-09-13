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

func TestGrubAddsNvidiaModesetOnlyWhenTheProprietaryDriverIsPresent(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)

	applyGrub(context.Background(), policy.Settings{
		Grub: &policy.Grub{BootSplash: true},
	}, env)

	body := read(t, env, grubConfPath)
	if !strings.Contains(body, "nvidia-drm.modeset=1") {
		t.Errorf("nvidia-drm.modeset=1 missing with the proprietary driver present:\n%s", body)
	}
}

func TestGrubNeverAddsNvidiaModesetWithoutTheProprietaryDriver(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyGrub(context.Background(), policy.Settings{
		Grub: &policy.Grub{BootSplash: true},
	}, env)

	body := read(t, env, grubConfPath)
	if strings.Contains(body, "nvidia-drm.modeset") {
		t.Errorf("nvidia-drm.modeset was added on a machine with no nvidia driver:\n%s", body)
	}
}

func TestNvidiaModulesAreAddedToTheInitramfsWhenTheDriverIsPresent(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)
	if err := env.WriteFile(initramfsModulesPath, "# comment\n", 0o644, "root", "root"); err != nil {
		t.Fatal(err)
	}

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, initramfsModulesPath)
	for _, module := range []string{"nvidia", "nvidia_modeset", "nvidia_drm"} {
		if !strings.Contains(body, module) {
			t.Errorf("%s missing from initramfs modules:\n%s", module, body)
		}
	}
	if !runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("adding the nvidia modules did not rebuild the initramfs")
	}
}

func TestNvidiaModulesAreNotTouchedWithoutTheProprietaryDriver(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if _, err := os.Stat(env.Path(initramfsModulesPath)); err == nil {
		t.Error("initramfs modules file was created on a machine with no nvidia driver")
	}
}

func TestNvidiaModulesAlreadyPresentDoNotForceARebuild(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	writeNvidiaMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"
	if err := env.WriteFile(
		initramfsModulesPath, "nvidia\nnvidia_modeset\nnvidia_drm\n", 0o644, "root", "root",
	); err != nil {
		t.Fatal(err)
	}

	// First pass establishes every other baseline (the theme's own
	// signature); only after that is "nothing changed" a meaningful check.
	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)
	runner.commands = nil

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("already-present nvidia modules triggered a rebuild")
	}
}

// MODULES=most is what bundles amdgpu, i915 and every other open-source
// driver into the initramfs — the reason a non-nvidia machine gets early
// graphics at all. Widened whenever the splash is on, whatever GPU is
// actually in the machine, since Plymouth needs early KMS from whichever
// driver applies regardless of vendor.
func TestInitramfsModulesModeIsWidenedToMost(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	if err := env.WriteFile(initramfsConfPath, "MODULES=dep\n", 0o644, "root", "root"); err != nil {
		t.Fatal(err)
	}

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	body := read(t, env, initramfsConfPath)
	if !strings.Contains(body, "MODULES=most") || strings.Contains(body, "MODULES=dep") {
		t.Errorf("MODULES was not widened to most:\n%s", body)
	}
	if !runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("widening MODULES did not rebuild the initramfs")
	}
}

func TestInitramfsModulesAlreadyMostIsLeftAloneAndDoesNotForceARebuild(t *testing.T) {
	env, runner := testEnv(t)
	writePlymouthInstalledMarker(t, env)
	runner.output["plymouth-set-default-theme"] = splashTheme + "\n"
	if err := env.WriteFile(initramfsConfPath, "MODULES=most\n", 0o644, "root", "root"); err != nil {
		t.Fatal(err)
	}

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)
	runner.commands = nil

	applyBootSplash(context.Background(), &policy.Grub{BootSplash: true}, env)

	if runner.ran("plymouth-set-default-theme", "-R") {
		t.Error("MODULES already being most triggered a rebuild")
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
