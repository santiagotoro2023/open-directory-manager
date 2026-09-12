package apply

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPinnedApplicationsKeepTheirOrderAndGainTheSuffix(t *testing.T) {
	got := desktopIDs("firefox-esr, org.gnome.Nautilus.desktop , ,org.remmina.Remmina")
	want := []string{
		"firefox-esr.desktop",
		"org.gnome.Nautilus.desktop",
		"org.remmina.Remmina.desktop",
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, wanted %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Errorf("position %d is %q, wanted %q", index, got[index], want[index])
		}
	}
}

func TestAnEntryThatCouldEscapeTheCommandIsDropped(t *testing.T) {
	// This ends up inside a shell command run as the person signing in.
	for _, bad := range []string{"a'; rm -rf /; echo '", "../../etc/passwd", `x".desktop`} {
		if got := desktopIDs(bad); len(got) != 0 {
			t.Errorf("%q was kept as %v", bad, got)
		}
	}
}

func TestTheDashScriptSetsOnlyTheFavourites(t *testing.T) {
	script := dashScript([]string{"a.desktop", "b.desktop"})
	if !strings.Contains(script, `gsettings set org.gnome.shell favorite-apps "['a.desktop', 'b.desktop']"`) {
		t.Errorf("the script does not set the favourites:\n%s", script)
	}
	// A machine with no GNOME must not fail the session over it.
	if !strings.Contains(script, "|| true") {
		t.Error("the script fails the session on a desktop that is not GNOME")
	}
}

// dashSeededWith is what "allow user change" checks before deciding whether
// to reapply the pinned layout: a marker matching the current layout means
// this person already has it and whatever they have done with it since is
// theirs to keep.
func TestASeededMarkerIsOnlyRecognisedForTheSameLayout(t *testing.T) {
	marker := filepath.Join(t.TempDir(), dashMarkerName)

	if dashSeededWith(marker, "a.desktop,b.desktop") {
		t.Error("an unwritten marker was read as seeded")
	}

	if err := os.WriteFile(marker, []byte("a.desktop,b.desktop\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !dashSeededWith(marker, "a.desktop,b.desktop") {
		t.Error("a marker matching the layout was not recognised")
	}
	// The operator changed the layout since it was seeded: a stale marker
	// must not be read as "already has this", or nobody would ever receive
	// an updated default.
	if dashSeededWith(marker, "a.desktop,c.desktop") {
		t.Error("a marker for a different layout was read as seeded")
	}
}
