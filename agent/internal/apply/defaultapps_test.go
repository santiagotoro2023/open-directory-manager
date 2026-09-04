package apply

import (
	"context"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func TestDefaultApplicationsWriteBothTheTypeAndWhatOpensIt(t *testing.T) {
	env, runner := testEnv(t)
	results := applyDefaultApplications(context.Background(), policy.Settings{
		DefaultApplications: []policy.DefaultApplication{
			{
				MimeType:    "application/x-rdp",
				Application: "org.remmina.Remmina.desktop",
				Extensions:  "rdp, .RDP",
			},
			{MimeType: "application/pdf", Application: "org.gnome.Evince.desktop"},
		},
	}, env)

	list := read(t, env, mimeAppsListPath)
	// Both sections: a type whose only association is the default one is
	// offered by nothing in "Open with".
	for _, want := range []string{
		"[Default Applications]",
		"application/x-rdp=org.remmina.Remmina.desktop",
		"application/pdf=org.gnome.Evince.desktop",
		"[Added Associations]",
	} {
		if !strings.Contains(list, want) {
			t.Errorf("mimeapps.list has no %q:\n%s", want, list)
		}
	}

	// A type Debian has never heard of needs registering before anything can
	// be the default for it.
	types := read(t, env, mimePackagePath)
	if !strings.Contains(types, `<mime-type type="application/x-rdp">`) ||
		!strings.Contains(types, `<glob pattern="*.rdp"/>`) {
		t.Errorf("the MIME package does not register .rdp:\n%s", types)
	}
	// The one with no extensions is already known to the machine.
	if strings.Contains(types, "application/pdf") {
		t.Error("registered a glob for a type that was given no extensions")
	}
	if !runner.ran("update-mime-database", "/usr/share/mime") {
		t.Error("the MIME database was not rebuilt, so the new type is not known yet")
	}
	if len(results) == 0 {
		t.Error("nothing was reported")
	}
}

func TestADefaultThatIsNotAMimeTypeAndADesktopEntryIsSkippedRatherThanWritten(t *testing.T) {
	env, _ := testEnv(t)
	results := applyDefaultApplications(context.Background(), policy.Settings{
		DefaultApplications: []policy.DefaultApplication{
			{MimeType: "application/x-rdp", Application: "remmina"},
			{MimeType: "rdp", Application: "a.desktop"},
			{MimeType: "application/x-rdp\"", Application: "a.desktop"},
			{MimeType: "text/html", Application: "firefox-esr.desktop"},
		},
	}, env)

	list := read(t, env, mimeAppsListPath)
	if !strings.Contains(list, "text/html=firefox-esr.desktop") {
		t.Errorf("the one good entry was not written:\n%s", list)
	}
	if strings.Contains(list, "remmina\n") || strings.Contains(list, "rdp=") {
		t.Errorf("a rejected entry reached the file:\n%s", list)
	}
	skipped := 0
	for _, result := range results {
		if result.Status == "skipped" {
			skipped++
		}
	}
	if skipped != 3 {
		t.Errorf("reported %d skipped entries, wanted 3", skipped)
	}
}

func TestExtensionsAreTakenWithOrWithoutTheDotAndNeverWithMarkup(t *testing.T) {
	if got := extensionsOf(" rdp , .ica,, x<y "); len(got) != 2 || got[0] != "rdp" || got[1] != "ica" {
		t.Errorf("extensionsOf gave %v", got)
	}
	if extensionsOf("") != nil {
		t.Error("an empty list is no extensions, not one empty one")
	}
}

func TestOnlyARealMimeTypeAndDesktopEntryReachTheseFiles(t *testing.T) {
	for _, good := range []string{"application/pdf", "x-scheme-handler/https"} {
		if !safeMimeType(good) {
			t.Errorf("%q should be a MIME type", good)
		}
	}
	for _, bad := range []string{"pdf", "a/", "/b", "a b/c", `a"/c`, "a/c=d"} {
		if safeMimeType(bad) {
			t.Errorf("%q should not be a MIME type", bad)
		}
	}
	if !safeDesktopID("org.gnome.Evince.desktop") {
		t.Error("a desktop entry was rejected")
	}
	for _, bad := range []string{"evince", "/etc/passwd.desktop", "a b.desktop", `a".desktop`} {
		if safeDesktopID(bad) {
			t.Errorf("%q should not be a desktop entry", bad)
		}
	}
}
