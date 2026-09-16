package apply

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func TestRegionalSettingsReachTheSystemTheDesktopAndTheClock(t *testing.T) {
	env, run := testEnv(t)
	// The installer's files, which must survive with their own lines.
	_ = os.MkdirAll(env.Path("/etc/default"), 0o755)
	_ = os.WriteFile(env.Path("/etc/default/locale"), []byte("LANG=en_US.UTF-8\n"), 0o644)
	_ = os.WriteFile(env.Path("/etc/default/keyboard"), []byte("XKBMODEL=\"pc105\"\nXKBLAYOUT=\"us\"\n"), 0o644)
	_ = os.WriteFile(env.Path("/etc/locale.gen"), []byte("# en_US.UTF-8 UTF-8\nen_US.UTF-8 UTF-8\n"), 0o644)
	_ = os.WriteFile(env.Path("/etc/timezone"), []byte("Etc/UTC\n"), 0o644)

	settings := policy.Settings{Regional: &policy.Regional{
		Locale: "de_CH.UTF-8", FormatsLocale: "de_CH.UTF-8", AdditionalLocales: []string{"fr_CH.UTF-8"},
		KeyboardLayout: "ch", KeyboardVariant: "de_nodeadkeys", Timezone: "Europe/Zurich",
	}}
	results := applyRegional(context.Background(), settings, env)
	for _, result := range results {
		if result.Status == "failed" {
			t.Fatalf("%s failed: %s", result.Setting, result.Reason)
		}
	}
	locale, _ := os.ReadFile(env.Path("/etc/default/locale"))
	if !strings.HasPrefix(string(locale), "LANG=en_US.UTF-8\n") || !strings.Contains(string(locale), "LANG=de_CH.UTF-8") {
		t.Errorf("the system locale keeps its own line and gains ours:\n%s", locale)
	}
	keyboard, _ := os.ReadFile(env.Path("/etc/default/keyboard"))
	if !strings.Contains(string(keyboard), "XKBLAYOUT=\"ch\"") || !strings.Contains(string(keyboard), "XKBMODEL=\"pc105\"") {
		t.Errorf("keyboard:\n%s", keyboard)
	}
	gen, _ := os.ReadFile(env.Path("/etc/locale.gen"))
	if !strings.Contains(string(gen), "fr_CH.UTF-8 UTF-8") || !strings.Contains(string(gen), "# en_US.UTF-8 UTF-8") {
		t.Errorf("locale.gen:\n%s", gen)
	}
	dconf, _ := os.ReadFile(env.Path(dconfRegionalPath))
	if !strings.Contains(string(dconf), "sources=[('xkb', 'ch+de_nodeadkeys')]") {
		t.Errorf("dconf:\n%s", dconf)
	}
	locks, _ := os.ReadFile(env.Path(dconfRegionalLocks))
	if !strings.Contains(string(locks), "/org/gnome/desktop/input-sources/sources") {
		t.Errorf("the layout is locked when people may not change it:\n%s", locks)
	}
	if !run.ran("locale-gen", "") || !run.ran("timedatectl", "set-timezone Europe/Zurich") || !run.ran("dconf", "update") {
		t.Errorf("commands: %v", run.commands)
	}

	// Taken away: the block leaves, the installer's lines stay.
	before := env.State
	env2 := Env{Root: env.Root, Run: run, State: NewState()}
	_ = applyRegional(context.Background(), policy.Settings{}, env2)
	env2.Prune(before)
	locale, _ = os.ReadFile(env.Path("/etc/default/locale"))
	if strings.Contains(string(locale), "de_CH") || !strings.Contains(string(locale), "LANG=en_US.UTF-8") {
		t.Errorf("after removal:\n%s", locale)
	}
}

func TestLogonHoursWriteTheRulesAndOnePamLine(t *testing.T) {
	env, run := testEnv(t)
	_ = os.MkdirAll(env.Path("/etc/pam.d"), 0o755)
	stack := "account [success=1 new_authtok_reqd=done default=ignore] pam_unix.so\naccount requisite pam_deny.so\naccount required pam_permit.so\n"
	_ = os.WriteFile(env.Path(pamAccountPath), []byte(stack), 0o644)
	settings := policy.Settings{LogonHours: []policy.LogonHoursRule{
		{Principal: "%sales", Days: []string{"mon", "tue"}, Start: "07:00", End: "19:00", SignOut: true},
	}}
	results := applyLogonHours(context.Background(), settings, env)
	for _, result := range results {
		if result.Status == "failed" {
			t.Fatalf("%s failed: %s", result.Setting, result.Reason)
		}
	}
	pam, _ := os.ReadFile(env.Path(pamAccountPath))
	if !strings.Contains(string(pam), "odm-agent logon-hours") || !strings.HasPrefix(string(pam), "account [success=1") {
		t.Errorf("pam stack:\n%s", pam)
	}
	rules, _ := os.ReadFile(env.Path(logonHoursPath))
	if !strings.Contains(string(rules), "\"%sales\"") {
		t.Errorf("rules:\n%s", rules)
	}
	if _, err := os.Stat(env.Path(logonHoursTimer)); err != nil {
		t.Error("a sign-out rule needs the timer")
	}
	if !run.ran("systemctl", "enable --now odm-logon-hours.timer") {
		t.Errorf("timer not enabled: %v", run.commands)
	}

	// Gone: the line goes, the stack's own lines stay.
	_ = applyLogonHours(context.Background(), policy.Settings{}, env)
	pam, _ = os.ReadFile(env.Path(pamAccountPath))
	if strings.Contains(string(pam), "odm-agent") || string(pam) != stack {
		t.Errorf("after removal:\n%s", pam)
	}
}

func TestAWebAppBecomesALauncherWithTheLargestIconTheSiteDeclares(t *testing.T) {
	env, run := testEnv(t)
	dir := t.TempDir()
	_ = os.WriteFile(dir+"/chromium", []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", dir)
	var fetched []string
	webAppFetch = func(_ context.Context, location string) ([]byte, string, string, error) {
		fetched = append(fetched, location)
		switch location {
		case "https://outlook.office.com/mail/":
			page := `<html><head><link rel="icon" href="/favicon.ico" sizes="32x32">` +
				`<link rel="apple-touch-icon" sizes="180x180" href="/img/touch.png">` +
				`<link rel="manifest" href="/manifest.json"></head></html>`
			return []byte(page), "text/html", "https://outlook.office.com/mail/", nil
		case "https://outlook.office.com/manifest.json":
			return []byte(`{"icons":[{"src":"/img/big-512.png","sizes":"512x512"}]}`), "application/json", location, nil
		case "https://outlook.office.com/img/big-512.png":
			return []byte("PNG512"), "image/png", location, nil
		}
		return nil, "", "", fmt.Errorf("unexpected %s", location)
	}
	settings := policy.Settings{WebApps: []policy.WebApp{
		{Name: "Outlook", URL: "https://outlook.office.com/mail/", Categories: []string{"Office"}},
	}}
	results := applyWebApps(context.Background(), settings, env)
	if len(results) != 1 || results[0].Status != "success" {
		t.Fatalf("results: %+v", results)
	}
	entry := read(t, env, "/usr/share/applications/odm-webapp-outlook.desktop")
	for _, want := range []string{"Name=Outlook", "Exec=chromium --app=https://outlook.office.com/mail/ --class=odm-webapp-outlook",
		"StartupWMClass=odm-webapp-outlook", "Categories=Office;", "odm-webapp-outlook-"} {
		if !strings.Contains(entry, want) {
			t.Errorf("entry lacks %q:\n%s", want, entry)
		}
	}
	if len(fetched) != 3 || fetched[2] != "https://outlook.office.com/img/big-512.png" {
		t.Errorf("the 512px manifest icon should have been chosen: %v", fetched)
	}
	icons, _ := filepath.Glob(env.Path("/usr/share/icons/hicolor/256x256/apps/odm-webapp-outlook-*.png"))
	if len(icons) != 1 {
		t.Fatalf("one icon file expected: %v", icons)
	}
	if body, _ := os.ReadFile(icons[0]); string(body) != "PNG512" {
		t.Error("the icon was not the one fetched")
	}
	if !run.ran("update-desktop-database", "") {
		t.Error("the desktop database was not refreshed")
	}
	if webAppSlug("Microsoft Teams (web)") != "microsoft-teams-web" {
		t.Error(webAppSlug("Microsoft Teams (web)"))
	}
}

func TestAnUploadedIconIsWrittenAsItIs(t *testing.T) {
	env, _ := testEnv(t)
	dir := t.TempDir()
	_ = os.WriteFile(dir+"/chromium", []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", dir)
	webAppFetch = func(_ context.Context, location string) ([]byte, string, string, error) {
		return nil, "", "", fmt.Errorf("nothing should be fetched for an uploaded icon, asked for %s", location)
	}
	settings := policy.Settings{WebApps: []policy.WebApp{
		{Name: "Teams", URL: "https://teams.microsoft.com/", IconURL: "data:image/png;base64,UE5H"},
	}}
	results := applyWebApps(context.Background(), settings, env)
	if len(results) != 1 || results[0].Status != "success" {
		t.Fatalf("results: %+v", results)
	}
	icons, _ := filepath.Glob(env.Path("/usr/share/icons/hicolor/256x256/apps/odm-webapp-teams-*.png"))
	if len(icons) != 1 {
		t.Fatalf("one icon file expected: %v", icons)
	}
	if body, _ := os.ReadFile(icons[0]); string(body) != "PNG" {
		t.Error("the uploaded icon was not decoded")
	}
}

// The Firefox launcher is a shell script inside a Go string. It is run here,
// with a firefox that records what it was asked, because a variable lost to
// an edit is invisible to the compiler and fatal to the script.
func TestTheFirefoxLauncherMakesAProfileAndOpensAnApplicationWindow(t *testing.T) {
	env, _ := testEnv(t)
	bin := t.TempDir()
	log := bin + "/firefox.log"
	_ = os.WriteFile(bin+"/firefox", []byte("#!/bin/sh\necho \"$@\" > "+log+"\n"), 0o755)
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", "")
	webAppFetch = func(_ context.Context, location string) ([]byte, string, string, error) {
		return nil, "", "", fmt.Errorf("no icon for %s", location)
	}
	settings := policy.Settings{WebApps: []policy.WebApp{{Name: "Outlook", URL: "https://outlook.office.com/mail/"}}}
	results := applyWebApps(context.Background(), settings, env)
	if len(results) != 1 || results[0].Status != "success" {
		t.Fatalf("results: %+v", results)
	}
	entry := read(t, env, "/usr/share/applications/odm-webapp-outlook.desktop")
	if !strings.Contains(entry, "Exec="+webAppLauncher+" outlook https://outlook.office.com/mail/") {
		t.Fatalf("a machine without Chromium gets the launcher:\n%s", entry)
	}
	script := env.Path(webAppLauncher)
	if strings.Contains(read(t, env, webAppLauncher), `[ "" `) {
		t.Fatal("a variable went missing from the launcher")
	}
	if out, err := exec.Command("sh", "-n", script).CombinedOutput(); err != nil {
		t.Fatalf("the launcher does not parse: %v %s", err, out)
	}
	if out, err := exec.Command("sh", script, "outlook", "https://outlook.office.com/mail/").CombinedOutput(); err != nil {
		t.Fatalf("running the launcher: %v %s", err, out)
	}
	profile := home + "/.local/share/odm-webapps/outlook"
	prefs, err := os.ReadFile(profile + "/user.js")
	if err != nil || !strings.Contains(string(prefs), "legacyUserProfileCustomizations") {
		t.Fatalf("no profile was made: %v", err)
	}
	if css, err := os.ReadFile(profile + "/chrome/userChrome.css"); err != nil || !strings.Contains(string(css), "#nav-bar") {
		t.Fatalf("the toolbar is not hidden: %v", err)
	}
	args, _ := os.ReadFile(log)
	for _, want := range []string{"--no-remote", "--class odm-webapp-outlook", "--profile " + profile, "https://outlook.office.com/mail/"} {
		if !strings.Contains(string(args), want) {
			t.Errorf("firefox was not asked for %q: %s", want, args)
		}
	}
}

func TestFirmwareReportOnlyListsWhatCouldBeUpdated(t *testing.T) {
	env, run := testEnv(t)
	dir := t.TempDir()
	_ = os.WriteFile(dir+"/fwupdmgr", []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", dir)
	run.output["fwupdmgr"] = `{"Devices":[{"Name":"System Firmware","Version":"1.14","Releases":[{"Version":"1.16","Summary":"Fixes"}]}]}`
	settings := policy.Settings{FirmwareUpdates: &policy.FirmwareUpdates{Enabled: true, Mode: "report"}}
	results := applyFirmwareUpdates(context.Background(), settings, env)
	if len(results) != 1 || results[0].Status != "success" || !strings.Contains(results[0].Reason, "System Firmware 1.14 → 1.16") {
		t.Fatalf("results: %+v", results)
	}
	if run.ran("fwupdmgr", "update -y") {
		t.Error("report mode installed something")
	}
	pending := PendingFirmware(env)
	if len(pending) != 1 || pending[0].Version != "1.16" {
		t.Errorf("pending: %+v", pending)
	}
}
