package apply

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// What is pinned to the dash, and in what order.
//
// A user setting, so one function group gets a different set from another —
// the same shape as a drive map, and for the same reason: it is decided by
// who is signing in, not by which machine they signed in to.
//
// Written as an autostart entry rather than into a system dconf database,
// because a system database is one value for everybody on the machine and
// this is deliberately not that. The entry runs inside the session, where
// there is a session bus to write the setting through — at the point PAM runs
// there is not one yet.
//
// ponytail: GNOME Shell's favourites. XFCE's panel and KDE's task manager
// keep their launchers somewhere else entirely; each is its own applier if
// somebody wants it, and this one does not get in their way.
const dashScriptName = "odm-dash.sh"

func DeployDash(
	ctx context.Context, layouts []policy.DashLayout, user string, env Env,
) []error {
	// Not "nothing to do" when the list is empty: a layout this person has
	// stopped being entitled to has to go.
	state := loadCreated(env)
	if len(layouts) == 0 && len(state.Dash) == 0 {
		return nil
	}
	who, err := lookupAccount(user)
	if err != nil || who.uid < 1000 {
		return nil
	}

	memberships := groupsOf(user)
	var problems []error
	written := []string{}

	// The last one that applies wins, the way the last-applied GPO does
	// everywhere else in the policy: two layouts reaching one person is a
	// precedence question the control plane has already answered by ordering
	// them.
	applications := ""
	matched := false
	for _, layout := range layouts {
		if !appliesTo(layout.ForPrincipal, user, memberships) {
			continue
		}
		applications = layout.Applications
		matched = true
	}

	config := filepath.Join(who.home, ".config")
	autostart := filepath.Join(config, "autostart")
	script := filepath.Join(config, dashScriptName)
	entry := filepath.Join(autostart, "odm-dash.desktop")

	if matched {
		pinned := desktopIDs(applications)
		if err := makeUnder(who, autostart); err != nil {
			problems = append(problems, err)
		} else if err := writeAs(who, script, dashScript(pinned), 0o755); err != nil {
			problems = append(problems, err)
		} else if err := writeAs(who, entry, dashEntry(script), 0o644); err != nil {
			problems = append(problems, err)
		} else {
			written = append(written, script, entry)
			// And now, so the person signing in does not have to sign in
			// again to see it. Best effort: at session open there may be no
			// session bus yet, and the autostart entry is what covers that.
			applyNow(ctx, user, pinned, env)
		}
	}

	for _, gone := range goneFrom(state.Dash, written) {
		if !strings.HasPrefix(gone, who.home) {
			continue // another person's home; their own session removes it
		}
		if err := os.Remove(gone); err != nil && !os.IsNotExist(err) {
			problems = append(problems, fmt.Errorf("removing %s: %w", gone, err))
			written = append(written, gone) // still there; try again next time
		}
	}

	state.Dash = merge(state.Dash, written, who.home)
	saveCreated(env, state)
	return problems
}

// dashScript sets the favourites and nothing else, so a person can still
// rearrange what is there until the next sign-in.
func dashScript(pinned []string) string {
	quoted := make([]string, 0, len(pinned))
	for _, id := range pinned {
		quoted = append(quoted, "'"+id+"'")
	}
	return "#!/bin/sh\n" + Header +
		"# What Open Directory Manager pins to the dash for this account.\n" +
		"gsettings set org.gnome.shell favorite-apps \"[" +
		strings.Join(quoted, ", ") + "]\" 2>/dev/null || true\n"
}

func dashEntry(script string) string {
	return "[Desktop Entry]\n" +
		"Type=Application\n" +
		"Name=Open Directory Manager dash\n" +
		"Exec=/bin/sh " + script + "\n" +
		"NoDisplay=true\n" +
		"X-GNOME-Autostart-enabled=true\n"
}

// applyNow runs the same script inside the session that is starting, for the
// case where there is already a bus to reach.
func applyNow(ctx context.Context, user string, pinned []string, env Env) {
	if env.Run == nil || len(pinned) == 0 {
		return
	}
	_, _ = env.Run.Run(ctx, "runuser", "-u", user, "--",
		"gsettings", "set", "org.gnome.shell", "favorite-apps",
		"["+strings.Join(quoteAll(pinned), ", ")+"]")
}

func quoteAll(values []string) []string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, "'"+value+"'")
	}
	return quoted
}

// desktopIDs is the list the console wrote, in order, keeping only what can
// be a desktop entry: this ends up inside a shell command run as the person
// signing in.
func desktopIDs(value string) []string {
	var found []string
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.HasSuffix(part, ".desktop") {
			part += ".desktop"
		}
		if !safeDesktopID(part) {
			continue
		}
		found = append(found, part)
	}
	return found
}

// writeAs writes a file and leaves it belonging to the person whose home it
// is in, not to root.
func writeAs(who account, path, body string, mode os.FileMode) error {
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		return err
	}
	return os.Chown(path, who.uid, who.gid)
}
