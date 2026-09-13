package apply

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The greeter's login background, on GNOME (CLAUDE.md §3.5, §5.2).
//
// GNOME Shell — the greeter's and every desktop session's, since they are the
// same program — reads its background from the theme it was compiled with,
// not from a setting: the dconf keys loginscreen.go writes apply the banner
// and the user list and stop there, which greeterBackgroundResult already
// says plainly rather than claiming a picture applied when nobody can see
// it. Making the picture itself show up means changing what the compiled
// theme says.
//
// Always rebuilt from a pristine copy taken before this ever touched
// anything, never from whatever is currently live: patching an
// already-patched file would nest one background inside another, and there
// would be no way back to the distribution's own theme once one was set.
// The live file is only ever replaced by a copy that has already been
// proven readable by the same tool that reads it for real.
const (
	shellThemeBackup       = "/var/lib/odm/gnome-shell-theme.gresource.orig"
	shellThemeWork         = "/var/lib/odm/gnome-shell-theme-src"
	shellThemeBuilt        = "/var/lib/odm/gnome-shell-theme.gresource.new"
	shellThemePrefix       = "/org/gnome/shell/theme"
	shellThemeBackgroundID = "odm-login-background"
	// What this machine last built the theme from, so an unchanged setting
	// does not rebuild and restart the greeter on every policy refresh.
	shellThemeSignaturePath = "/var/lib/odm/gnome-shell-theme.signature"

	gresourceTool   = "/usr/bin/gresource"
	glibCompileTool = "/usr/bin/glib-compile-resources"
)

// glibToolsInstalled reports whether the two tools this needs are on the
// machine. Neither ships with a GNOME desktop by default — glib-compile-
// resources in particular is in the "-dev-bin" package — so this is checked
// before anything else, the same way oathInstalled is: a machine without it
// gets a clear skipped reason instead of a command that fails halfway
// through the greeter's own theme.
func glibToolsInstalled(env Env) bool {
	for _, tool := range []string{gresourceTool, glibCompileTool} {
		if _, err := os.Stat(env.Path(tool)); err != nil {
			return false
		}
	}
	return true
}

// applyGreeterBackground makes the picture itself show up at the greeter, on
// top of the banner and user-list keys loginscreen.go already writes. Called
// once per applyLoginScreen run, whether or not a background is set: a
// background that was removed from policy has to restore the distribution's
// own theme, not merely stop being rebuilt from it.
func applyGreeterBackground(ctx context.Context, env Env, background, fit string) result {
	if _, err := os.Stat(env.Path(shellTheme)); err != nil {
		return skippedResult("this machine has no compiled GNOME Shell theme to patch")
	}

	if background == "" {
		return restoreGreeterTheme(env)
	}

	if env.Run == nil {
		return skippedResult("no command runner")
	}
	// The client package depends on this, but a machine joined before that
	// dependency existed only ever gets its agent binary swapped in place —
	// replacing a binary is not apt installing a package, so the dependency
	// a newer version of it needs is not something a self-update can bring
	// along by itself. Installed here instead, the same way a missing
	// libpam-pwquality is for the local password policy.
	if !glibToolsInstalled(env) {
		if out, err := env.Run.Run(ctx, "apt-get", "install", "-y",
			"--no-install-recommends", "libglib2.0-dev-bin"); err != nil {
			return skippedResult(fmt.Sprintf(
				"gresource and glib-compile-resources are not installed, and installing "+
					"libglib2.0-dev-bin to get them failed: %v: %s. The banner and the user "+
					"list applied regardless.", err, lastLine(out)))
		}
		if !glibToolsInstalled(env) {
			return skippedResult(
				"installed libglib2.0-dev-bin, but gresource or glib-compile-resources is " +
					"still not where this expects it. The banner and the user list applied " +
					"regardless.",
			)
		}
	}

	imagePath := strings.TrimPrefix(background, "file://")
	image, err := os.ReadFile(env.Path(imagePath))
	if err != nil {
		return failedResult(fmt.Errorf("reading the background picture: %w", err))
	}

	signature := signatureOf(image, fit)
	if current, err := os.ReadFile(env.Path(shellThemeSignaturePath)); err == nil &&
		strings.TrimSpace(string(current)) == signature {
		// Still wanted, just already right (Env.Keep). Losing the signature
		// here would not damage the theme — that is installed outside
		// WriteFile and never pruned — but it would make the next pass
		// believe it had never run, and rebuild and recompile the whole
		// gresource on every other refresh forever.
		env.Keep(shellThemeSignaturePath)
		return result{status: "unchanged", reason: "the greeter's theme already carries this picture"}
	}

	if err := ensureShellThemeBackup(env); err != nil {
		return failedResult(fmt.Errorf("keeping the distribution's own theme: %w", err))
	}

	built, err := buildGreeterTheme(ctx, env, image, fit)
	if err != nil {
		return failedResult(err)
	}

	// Proven readable by the exact tool that reads it for real before it is
	// ever allowed near the live path.
	if _, err := env.Run.Run(ctx, gresourceTool, "list", built); err != nil {
		return failedResult(fmt.Errorf("the rebuilt theme is not one gresource can read: %w", err))
	}

	if err := installFile(env, built, shellTheme, 0o644); err != nil {
		return failedResult(fmt.Errorf("installing the rebuilt theme: %w", err))
	}
	_ = env.WriteFile(shellThemeSignaturePath, signature+"\n", 0o600, "root", "root")

	if reloadGreeterShell(ctx, env) {
		return result{status: "success", reason: "the greeter's compiled theme now carries this picture"}
	}
	return result{
		status: "success",
		reason: "the greeter's compiled theme now carries this picture; somebody is signed in " +
			"locally right now, so it takes effect at their next login rather than ending their " +
			"session to show it immediately",
	}
}

// restoreGreeterTheme puts the distribution's own theme back, for a machine
// this once patched and whose policy no longer sets a background.
func restoreGreeterTheme(env Env) result {
	backup := env.Path(shellThemeBackup)
	if _, err := os.Stat(backup); err != nil {
		return skippedResult(
			"GNOME's greeter takes its background from its compiled shell theme, not from " +
				"a setting. The banner and the user list applied.",
		)
	}
	if err := installFile(env, backup, shellTheme, 0o644); err != nil {
		return failedResult(fmt.Errorf("restoring the distribution's own theme: %w", err))
	}
	_ = os.Remove(env.Path(shellThemeSignaturePath))
	return result{status: "success", reason: "the distribution's own theme was restored"}
}

// ensureShellThemeBackup takes the one copy of the theme as it was before
// this ever touched it. Written once: every rebuild after the first reads
// this copy, never the live file, so a second background never nests inside
// the first.
func ensureShellThemeBackup(env Env) error {
	backup := env.Path(shellThemeBackup)
	if _, err := os.Stat(backup); err == nil {
		return nil
	}
	live, err := os.ReadFile(env.Path(shellTheme))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(backup), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(backup+".tmp", live, 0o644); err != nil {
		return err
	}
	return os.Rename(backup+".tmp", backup)
}

// buildGreeterTheme extracts the pristine theme, adds the picture and an
// override rule to each stylesheet in it, and compiles the result. Returns
// the path to the new gresource file, not yet installed anywhere live.
func buildGreeterTheme(ctx context.Context, env Env, image []byte, fit string) (string, error) {
	work := env.Path(shellThemeWork)
	if err := os.RemoveAll(work); err != nil {
		return "", err
	}
	if err := os.MkdirAll(work, 0o755); err != nil {
		return "", err
	}

	listed, err := env.Run.Run(ctx, gresourceTool, "list", env.Path(shellThemeBackup))
	if err != nil {
		return "", fmt.Errorf("reading the distribution's theme: %w", err)
	}
	resources := parseGresourceList(listed)
	if len(resources) == 0 {
		return "", fmt.Errorf("the distribution's theme carries no resources to rebuild from")
	}

	var files []string
	var cssFiles []string
	for _, path := range resources {
		relative, ok := strings.CutPrefix(path, shellThemePrefix+"/")
		if !ok {
			continue // outside the theme's own prefix; not this rebuild's to carry
		}
		content, err := env.Run.Run(ctx, gresourceTool, "extract", env.Path(shellThemeBackup), path)
		if err != nil {
			return "", fmt.Errorf("extracting %s: %w", path, err)
		}
		full := filepath.Join(work, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			return "", err
		}
		files = append(files, relative)
		if strings.HasSuffix(relative, ".css") {
			cssFiles = append(cssFiles, relative)
		}
	}

	imageName := shellThemeBackgroundID + imageExtension(image)
	if err := os.WriteFile(filepath.Join(work, imageName), image, 0o644); err != nil {
		return "", err
	}
	files = append(files, imageName)

	override := greeterCSSOverride(imageName, fit)
	for _, name := range cssFiles {
		full := filepath.Join(work, filepath.FromSlash(name))
		existing, err := os.ReadFile(full)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(full, append(existing, []byte(override)...), 0o644); err != nil {
			return "", err
		}
	}

	manifest := filepath.Join(work, "theme.gresource.xml")
	if err := os.WriteFile(manifest, []byte(greeterManifestXML(shellThemePrefix, files)), 0o644); err != nil {
		return "", err
	}

	built := env.Path(shellThemeBuilt)
	if _, err := env.Run.Run(ctx, glibCompileTool,
		"--sourcedir="+work, manifest, "--target="+built,
	); err != nil {
		return "", fmt.Errorf("compiling the rebuilt theme: %w", err)
	}
	return built, nil
}

// greeterCSSOverride is appended to every stylesheet the theme carries, so
// whichever one the running Shell actually uses — the ordinary theme, the
// high-contrast one — shows the same picture. Later rules win in CSS, so
// appending is enough to override whatever the stylesheet already said about
// this element, without needing to find and edit that rule.
func greeterCSSOverride(imageName, fit string) string {
	return fmt.Sprintf(
		"\n/* Managed by Open Directory Manager. */\n"+
			"#lockDialogGroup {\n"+
			"  background: #1f2937 url(%q);\n"+
			"  background-size: %s;\n"+
			"  background-repeat: no-repeat;\n"+
			"  background-position: center;\n"+
			"}\n"+
			// GDM's greeter is screenShield.js's own shield actor with
			// loginDialog.js's dialog stacked in front of it — #lockDialogGroup
			// above is the shield, and .login-dialog is what actually sits on
			// screen. Left alone it paints over the picture with the theme's
			// own background, which reads as the setting having done nothing.
			".login-dialog { background-color: transparent; }\n",
		imageName, cssSize(fit),
	)
}

// greeterManifestXML is what glib-compile-resources reads to know which
// files, under which prefix, make up the rebuilt theme.
func greeterManifestXML(prefix string, files []string) string {
	var body strings.Builder
	body.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n<gresources>\n")
	fmt.Fprintf(&body, "  <gresource prefix=%q>\n", prefix)
	for _, name := range files {
		fmt.Fprintf(&body, "    <file>%s</file>\n", name)
	}
	body.WriteString("  </gresource>\n</gresources>\n")
	return body.String()
}

// parseGresourceList turns what "gresource list" prints — one resource path
// per line — into the list this rebuilds from. Blank lines are skipped
// rather than carried through as a resource nothing extracted.
func parseGresourceList(output string) []string {
	var paths []string
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			paths = append(paths, line)
		}
	}
	return paths
}

// imageExtension is guessed from the file's own bytes rather than trusted
// from a name that travelled through the console: what glib-compile-
// resources needs is a plausible file name, not a correct one, but a
// resource ending .desktop because that was the console's last upload of
// something else is the kind of detail that makes a rebuilt theme
// confusing to read on disk later.
func imageExtension(image []byte) string {
	switch {
	case len(image) >= 8 && string(image[1:4]) == "PNG":
		return ".png"
	case len(image) >= 3 && image[0] == 0xFF && image[1] == 0xD8:
		return ".jpg"
	case len(image) >= 6 && (string(image[:6]) == "GIF87a" || string(image[:6]) == "GIF89a"):
		return ".gif"
	default:
		return ".img"
	}
}

func signatureOf(image []byte, fit string) string {
	sum := sha256.Sum256(image)
	return fmt.Sprintf("%x-%s-%d", sum, fit, len(image))
}

// installFile copies src over dst atomically: a temporary file in dst's own
// directory, then a rename, so nothing reading dst mid-write ever sees a
// half-written theme.
func installFile(env Env, src, dst string, mode os.FileMode) error {
	content, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	full := env.Path(dst)
	temp := full + ".odm-tmp"
	if err := os.WriteFile(temp, content, mode); err != nil {
		return err
	}
	return os.Rename(temp, full)
}

// reloadGreeterShell asks the greeter to start over so it reads the theme
// this just installed, rather than the one it already had mapped into
// memory. Reports whether it actually did.
//
// Skipped rather than forced through while somebody is signed in locally:
// gdm3 is not just the greeter but the display manager hosting whatever
// session it handed that person, and restarting it ends that session the
// same way logging them out by hand would — a background policy refresh
// must never do that to somebody mid-work. Not fatal either way: a machine
// between logins picks up the new theme at the next one regardless.
func reloadGreeterShell(ctx context.Context, env Env) bool {
	if env.Run == nil {
		return false
	}
	if aLocalSessionIsActive(ctx, env) {
		return false
	}
	_, _ = env.Run.Run(ctx, "systemctl", "restart", "gdm3")
	return true
}

// aLocalSessionIsActive reports whether somebody is signed in at this
// machine's own seat right now, as opposed to over SSH or not at all.
//
// SESSION UID USER SEAT has been loginctl's own column order for as long as
// list-sessions has existed, whatever columns later versions appended after
// it, so the fourth field is read on trust without asking systemd for its
// version first. A session with no seat is remote or a background one
// (systemd's own per-user manager, in particular), and gdm3 does not own
// either kind.
func aLocalSessionIsActive(ctx context.Context, env Env) bool {
	if env.Run == nil {
		return false
	}
	out, err := env.Run.Run(ctx, "loginctl", "list-sessions", "--no-legend")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 4 && strings.HasPrefix(fields[3], "seat") {
			return true
		}
	}
	return false
}

// result is the same shape as policy.Result without the setting name, which
// the caller already knows.
type result struct {
	status string
	reason string
}

func skippedResult(reason string) result { return result{status: "skipped", reason: reason} }
func failedResult(err error) result      { return result{status: "failed", reason: err.Error()} }
