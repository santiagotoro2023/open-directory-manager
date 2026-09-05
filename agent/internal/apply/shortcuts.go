package apply

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Icons on a desktop, entries in a menu, and places in a file manager.
//
// Written in the session, like a drive map, because all three land in a home
// directory and are decided by who is signing in. Each is the format the
// desktop already reads: a desktop entry for the first two, and the GTK
// bookmarks file for the third, which is what puts a share in the sidebar of
// Files, Nautilus, Thunar and Nemo alike.

const gtkBookmarks = ".config/gtk-3.0/bookmarks"

// DeployShortcuts writes what this person gets and removes what they no
// longer do. Run from PAM at session open.
func DeployShortcuts(
	_ context.Context, shortcuts []policy.Shortcut, user string, env Env,
) []error {
	state := loadCreated(env)
	if len(shortcuts) == 0 && len(state.Shortcuts) == 0 {
		return nil
	}
	who, err := lookupAccount(user)
	if err != nil || who.uid < 1000 {
		return nil
	}

	memberships := groupsOf(user)
	desktop := desktopDir(who)
	menu := filepath.Join(who.home, ".local", "share", "applications")

	var problems []error
	written := []string{}
	var places []string

	for _, shortcut := range shortcuts {
		if !appliesTo(shortcut.ForPrincipal, user, memberships) {
			continue
		}
		if shortcut.Kind == "place" {
			places = append(places, bookmarkLine(shortcut))
			continue
		}
		body := desktopEntry(shortcut)
		file := safeName(shortcut.Name) + ".desktop"
		for _, dir := range entryDirs(shortcut.Where, desktop, menu) {
			if err := makeUnder(who, dir); err != nil {
				problems = append(problems, fmt.Errorf("%s: %w", shortcut.Name, err))
				continue
			}
			path := filepath.Join(dir, file)
			if err := writeAs(who, path, body, 0o755); err != nil {
				problems = append(problems, fmt.Errorf("%s: %w", shortcut.Name, err))
				continue
			}
			written = append(written, path)
		}
	}

	// The file manager's sidebar, which is one file rather than one per
	// entry. Only ours are rewritten: a line somebody added themselves is
	// theirs and stays.
	if err := writeBookmarks(who, places); err != nil {
		problems = append(problems, err)
	}

	for _, gone := range goneFrom(state.Shortcuts, written) {
		if !strings.HasPrefix(gone, who.home) {
			continue // another person's home; their own session removes it
		}
		if err := os.Remove(gone); err != nil && !os.IsNotExist(err) {
			problems = append(problems, fmt.Errorf("removing %s: %w", gone, err))
			written = append(written, gone) // still there; try again next time
		}
	}

	state.Shortcuts = merge(state.Shortcuts, written, who.home)
	saveCreated(env, state)
	return problems
}

func entryDirs(where, desktop, menu string) []string {
	switch where {
	case "menu":
		return []string{menu}
	case "both":
		return []string{desktop, menu}
	default:
		return []string{desktop}
	}
}

// desktopEntry is the freedesktop format every desktop on Debian reads.
func desktopEntry(shortcut policy.Shortcut) string {
	kind, exec := "Application", shortcut.Target
	if shortcut.Kind == "link" {
		kind = "Link"
	}
	body := &strings.Builder{}
	body.WriteString("[Desktop Entry]\n")
	fmt.Fprintf(body, "Type=%s\n", kind)
	fmt.Fprintf(body, "Name=%s\n", entryValue(shortcut.Name))
	if kind == "Link" {
		fmt.Fprintf(body, "URL=%s\n", entryValue(shortcut.Target))
	} else {
		fmt.Fprintf(body, "Exec=%s\n", entryValue(exec))
		body.WriteString("Terminal=false\n")
	}
	if shortcut.Icon != "" {
		fmt.Fprintf(body, "Icon=%s\n", entryValue(shortcut.Icon))
	}
	// Without this GNOME shows the icon with a "do you trust it" prompt the
	// first time somebody opens it, on every machine they sign in to.
	body.WriteString("X-GNOME-Autostart-enabled=false\n")
	return body.String()
}

// entryValue keeps a value on the one line a desktop entry gives it.
func entryValue(value string) string {
	return strings.NewReplacer("\n", " ", "\r", " ").Replace(value)
}

func bookmarkLine(shortcut policy.Shortcut) string {
	target := shortcut.Target
	if strings.HasPrefix(target, "/") {
		target = "file://" + target
	}
	// The name after the URI is what the sidebar shows; a space in it would
	// end the URI, so the name is what is left after the first one.
	return entryValue(target) + " " + entryValue(strings.ReplaceAll(shortcut.Name, "\n", " "))
}

// writeBookmarks replaces the lines this policy owns and leaves every other
// line where it was.
func writeBookmarks(who account, places []string) error {
	path := filepath.Join(who.home, gtkBookmarks)
	existing, _ := os.ReadFile(path)

	const marker = " # odm"
	var kept []string
	for _, line := range strings.Split(string(existing), "\n") {
		if strings.TrimSpace(line) == "" || strings.HasSuffix(line, marker) {
			continue
		}
		kept = append(kept, line)
	}
	for _, place := range places {
		kept = append(kept, place+marker)
	}
	if len(kept) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := makeUnder(who, filepath.Dir(path)); err != nil {
		return err
	}
	return writeAs(who, path, strings.Join(kept, "\n")+"\n", 0o644)
}
