package apply

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseGresourceListSkipsBlankLines(t *testing.T) {
	got := parseGresourceList("/org/gnome/shell/theme/gnome-shell.css\n\n/org/gnome/shell/theme/noise-texture.png\n")
	want := []string{
		"/org/gnome/shell/theme/gnome-shell.css",
		"/org/gnome/shell/theme/noise-texture.png",
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, wanted %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("position %d is %q, wanted %q", i, got[i], want[i])
		}
	}
}

func TestGreeterCSSOverrideNamesTheImageAndTheFit(t *testing.T) {
	css := greeterCSSOverride("odm-login-background.png", "stretched")
	if !strings.Contains(css, `url("odm-login-background.png")`) {
		t.Errorf("the image is not referenced:\n%s", css)
	}
	if !strings.Contains(css, "#lockDialogGroup") {
		t.Errorf("the wrong element is styled:\n%s", css)
	}
	if !strings.Contains(css, cssSize("stretched")) {
		t.Errorf("the fit did not translate to CSS:\n%s", css)
	}
}

func TestGreeterManifestXMLListsEveryFileUnderOnePrefix(t *testing.T) {
	xml := greeterManifestXML("/org/gnome/shell/theme", []string{
		"gnome-shell.css", "noise-texture.png", "odm-login-background.png",
	})
	if !strings.Contains(xml, `prefix="/org/gnome/shell/theme"`) {
		t.Errorf("the prefix is missing:\n%s", xml)
	}
	for _, want := range []string{"gnome-shell.css", "noise-texture.png", "odm-login-background.png"} {
		if !strings.Contains(xml, "<file>"+want+"</file>") {
			t.Errorf("%s is not listed:\n%s", want, xml)
		}
	}
}

func TestImageExtensionIsGuessedFromContentNotFromAName(t *testing.T) {
	png := append([]byte{0x89, 'P', 'N', 'G'}, make([]byte, 10)...)
	if got := imageExtension(png); got != ".png" {
		t.Errorf("PNG bytes guessed as %s", got)
	}
	jpg := []byte{0xFF, 0xD8, 0xFF, 0xE0}
	if got := imageExtension(jpg); got != ".jpg" {
		t.Errorf("JPEG bytes guessed as %s", got)
	}
	if got := imageExtension([]byte("not a picture")); got != ".img" {
		t.Errorf("unrecognised bytes guessed as %s", got)
	}
}

func TestSignatureChangesWithTheImageAndTheFit(t *testing.T) {
	a := signatureOf([]byte("one"), "zoom")
	b := signatureOf([]byte("one"), "stretched")
	c := signatureOf([]byte("two"), "zoom")
	if a == b || a == c || b == c {
		t.Errorf("signatures collided: %q %q %q", a, b, c)
	}
	if a != signatureOf([]byte("one"), "zoom") {
		t.Error("the same image and fit produced a different signature")
	}
}

// A machine that never compiled a GNOME Shell theme at all — a server, most
// often — is not a failure: there is nothing here for this to do.
func TestNoShellThemeIsSkippedNotFailed(t *testing.T) {
	env, _ := testEnv(t)
	got := applyGreeterBackground(context.Background(), env, "file:///usr/share/backgrounds/odm/x.png", "zoom")
	if got.status != "skipped" {
		t.Errorf("status = %q, wanted skipped: %s", got.status, got.reason)
	}
}

// A machine with the theme but without the tools that read and rebuild it
// is told what to install rather than left to guess why nothing changed.
func TestMissingToolsIsSkippedWithAClearReason(t *testing.T) {
	env, _ := testEnv(t)
	write(t, env, shellTheme, "not a real gresource file")

	got := applyGreeterBackground(context.Background(), env, "file:///usr/share/backgrounds/odm/x.png", "zoom")
	if got.status != "skipped" || !strings.Contains(got.reason, "libglib2.0-dev-bin") {
		t.Errorf("not reported as missing the tools: %+v", got)
	}
}

// Clearing the background restores whatever the distribution shipped,
// rather than leaving a machine that was ever patched stuck that way.
func TestClearingTheBackgroundRestoresTheOriginalTheme(t *testing.T) {
	env, _ := testEnv(t)
	write(t, env, shellTheme, "the distribution's own theme")
	write(t, env, shellThemeBackup, "the distribution's own theme")

	got := applyGreeterBackground(context.Background(), env, "", "zoom")

	if got.status != "success" {
		t.Fatalf("restoring was not reported as success: %+v", got)
	}
	if read(t, env, shellTheme) != "the distribution's own theme" {
		t.Error("the live theme was not restored from the backup")
	}
}

// A machine that was never patched has nothing to restore, and says so
// without pretending a setting applied.
func TestClearingAnUnsetBackgroundIsSkipped(t *testing.T) {
	env, _ := testEnv(t)
	write(t, env, shellTheme, "the distribution's own theme")

	got := applyGreeterBackground(context.Background(), env, "", "zoom")
	if got.status != "skipped" {
		t.Errorf("status = %q, wanted skipped", got.status)
	}
}

// The whole point of the signature is that an unchanged picture does not
// rebuild the theme and restart the greeter on every ordinary policy poll.
func TestAnUnchangedPictureIsNotRebuilt(t *testing.T) {
	env, runner := testEnv(t)
	write(t, env, gresourceTool, "")
	write(t, env, glibCompileTool, "")
	write(t, env, shellTheme, "theme")

	image := []byte("a picture, not really")
	path := "/usr/share/backgrounds/odm/x.png"
	if err := os.MkdirAll(filepath.Dir(env.Path(path)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(env.Path(path), image, 0o644); err != nil {
		t.Fatal(err)
	}
	write(t, env, shellThemeSignaturePath, signatureOf(image, "zoom"))

	got := applyGreeterBackground(context.Background(), env, "file://"+path, "zoom")

	if got.status != "unchanged" {
		t.Errorf("status = %q, wanted unchanged: %s", got.status, got.reason)
	}
	if len(runner.commands) != 0 {
		t.Errorf("a rebuild was attempted for an unchanged picture: %v", runner.commands)
	}
}
