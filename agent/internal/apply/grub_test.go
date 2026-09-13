package apply

import (
	"context"
	"os"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func TestGrubTimeoutIsWrittenAsADropInAndGrubRegenerated(t *testing.T) {
	env, runner := testEnv(t)

	results := applyGrub(context.Background(), policy.Settings{
		Grub: &policy.Grub{TimeoutSeconds: 5, HideMenu: false},
	}, env)

	body := read(t, env, grubConfPath)
	if !strings.Contains(body, "GRUB_TIMEOUT=5") {
		t.Errorf("the timeout is missing:\n%s", body)
	}
	if !strings.Contains(body, "GRUB_TIMEOUT_STYLE=menu") {
		t.Errorf("the style is missing:\n%s", body)
	}
	if !runner.ran("update-grub", "") {
		t.Error("update-grub was never run")
	}
	if len(results) != 1 || results[0].Status != "success" {
		t.Errorf("not reported as applied: %+v", results)
	}
}

// "Just boot into Debian" is what an operator asking to skip the menu
// entirely means, and GRUB's own way of saying that is TIMEOUT=0 with the
// style hidden — Escape during boot still reaches the menu, so nothing is
// actually taken away, only hidden until it is needed.
func TestSkippingTheMenuIsTimeoutZeroAndHiddenStyle(t *testing.T) {
	env, _ := testEnv(t)

	applyGrub(context.Background(), policy.Settings{
		Grub: &policy.Grub{TimeoutSeconds: 0, HideMenu: true},
	}, env)

	body := read(t, env, grubConfPath)
	if !strings.Contains(body, "GRUB_TIMEOUT=0") {
		t.Errorf("boot is not immediate:\n%s", body)
	}
	if !strings.Contains(body, "GRUB_TIMEOUT_STYLE=hidden") {
		t.Errorf("the menu is not hidden:\n%s", body)
	}
}

// "quiet" is what grub-mkconfig's own template checks before it prints
// "Loading Linux ..." and "Loading initial ramdisk ..."; GRUB_GFXPAYLOAD_
// LINUX=keep is what stops the kernel resetting to text mode and back,
// which is the other half of the flash a hidden menu alone did not fix.
func TestBootSplashAddsQuietAndKeepsTheGraphicsMode(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyGrub(context.Background(), policy.Settings{
		Grub: &policy.Grub{HideMenu: true, BootSplash: true},
	}, env)

	body := read(t, env, grubConfPath)
	for _, want := range []string{
		`GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"`,
		"GRUB_GFXPAYLOAD_LINUX=keep",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("grub drop-in missing %q:\n%s", want, body)
		}
	}
}

// A seamless splash and a visible boot menu are a contradiction: an operator
// who turned on the splash but left the menu on a countdown still gets a
// hidden, instant boot, because the whole point is nothing shows before the
// spinner — not even the menu, for however briefly its own timeout runs.
func TestBootSplashForcesTheMenuHiddenRegardlessOfItsOwnSetting(t *testing.T) {
	env, _ := testEnv(t)
	writePlymouthInstalledMarker(t, env)

	applyGrub(context.Background(), policy.Settings{
		Grub: &policy.Grub{TimeoutSeconds: 10, HideMenu: false, BootSplash: true},
	}, env)

	body := read(t, env, grubConfPath)
	if !strings.Contains(body, "GRUB_TIMEOUT=0") {
		t.Errorf("the splash left a visible countdown:\n%s", body)
	}
	if !strings.Contains(body, "GRUB_TIMEOUT_STYLE=hidden") {
		t.Errorf("the splash left the menu visible:\n%s", body)
	}
}

func TestBootSplashOffAddsNeitherCmdlineNorGfxpayload(t *testing.T) {
	env, _ := testEnv(t)

	applyGrub(context.Background(), policy.Settings{
		Grub: &policy.Grub{HideMenu: true, BootSplash: false},
	}, env)

	body := read(t, env, grubConfPath)
	if strings.Contains(body, "quiet") || strings.Contains(body, "GFXPAYLOAD") {
		t.Errorf("boot splash left cmdline changes behind while off:\n%s", body)
	}
}

func TestNoGrubSettingDoesNothing(t *testing.T) {
	env, runner := testEnv(t)

	results := applyGrub(context.Background(), policy.Settings{}, env)

	if results != nil {
		t.Errorf("got %+v, wanted nothing", results)
	}
	if len(runner.commands) != 0 {
		t.Errorf("a command ran with no setting at all: %v", runner.commands)
	}
}

// Removing the setting takes the drop-in with it — the generic file-pruning
// every applier gets from Env.WriteFile — and grub-mkconfig has to run again
// or the machine keeps booting on the timeout the removed policy asked for.
func TestRemovingTheSettingRegeneratesGrubToo(t *testing.T) {
	root := t.TempDir()
	runner := newRunner()

	first := Env{Root: root, Run: runner, State: NewState()}
	Apply(context.Background(), policy.Settings{
		Grub: &policy.Grub{TimeoutSeconds: 0, HideMenu: true},
	}, first)
	if _, err := os.Stat(first.Path(grubConfPath)); err != nil {
		t.Fatalf("the drop-in was never written: %v", err)
	}
	runner.commands = nil

	second := Env{Root: root, Run: runner, State: NewState()}
	Apply(context.Background(), policy.Settings{}, second)

	if _, err := os.Stat(second.Path(grubConfPath)); err == nil {
		t.Error("the drop-in was left behind after the setting was removed")
	}
	if !runner.ran("update-grub", "") {
		t.Error("grub was not regenerated after the drop-in was removed")
	}
}
