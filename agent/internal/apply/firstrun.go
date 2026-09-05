package apply

import (
	"context"
	"os"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// What somebody is shown the first time they sign in.
//
// A managed desktop has already been set up by whoever manages it, so the
// distribution's welcome tour is asking a person to choose things that are
// not theirs to choose — and it is the first thing every one of them asks
// about.

const (
	// GNOME runs the tour from an autostart entry. Overridden in /etc rather
	// than deleted from /usr, so a package upgrade does not bring it back and
	// nothing ODM does breaks apt.
	tourAutostart    = "/etc/xdg/autostart/gnome-initial-setup-first-login.desktop"
	welcomeAutostart = "/etc/xdg/autostart/gnome-welcome-tour.desktop"
	firstRunKeyfile  = "/etc/dconf/db/odm.d/20-odm-first-run"
	motdPath         = "/etc/motd"
)

func applyFirstRun(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.FirstRun == nil {
		return nil
	}
	first := *s.FirstRun
	var results []policy.Result

	for path, disable := range map[string]bool{
		tourAutostart:    first.DisableTour,
		welcomeAutostart: first.DisableWelcomeDialog,
	} {
		if disable {
			// A desktop entry that is hidden is one the session skips. The
			// documented way to switch one off for everybody.
			body := Header + "[Desktop Entry]\nType=Application\nHidden=true\n"
			if err := env.WriteFile(path, body, 0o644, "root", "root"); err != nil {
				results = append(results, policy.Fail("first_run", err))
			}
			continue
		}
		// Only ours: an entry the distribution shipped in /etc is not ODM's
		// to remove.
		if raw, err := os.ReadFile(env.Path(path)); err == nil &&
			strings.Contains(string(raw), "Open Directory Manager") {
			_ = os.Remove(env.Path(path))
		}
	}

	// And the shell's own welcome dialog, which is a dconf value rather than
	// an autostart entry. Set to a version far ahead of any that will ship,
	// which is how GNOME records "this person has already seen it".
	keyfile := Header + "[org/gnome/shell]\n"
	if first.DisableWelcomeDialog {
		keyfile += "welcome-dialog-last-shown-version='9999.0'\n"
	} else {
		keyfile += "welcome-dialog-last-shown-version=''\n"
	}
	if err := env.WriteFile(firstRunKeyfile, keyfile, 0o644, "root", "root"); err != nil {
		results = append(results, policy.Fail("first_run", err))
	}

	if first.Message != "" {
		if err := env.WriteFile(motdPath, first.Message+"\n", 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail("first_run:message", err))
		}
	}

	results = append(results, runAll(ctx, env, "first_run", []string{"dconf", "update"}))
	return results
}
