package apply

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

// fakeRunner records commands instead of running them, so the appliers can
// be tested without systemd, nft or sshd on the machine.
type fakeRunner struct {
	commands [][]string
	fail     map[string]string
	output   map[string]string
}

func newRunner() *fakeRunner {
	return &fakeRunner{fail: map[string]string{}, output: map[string]string{}}
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	f.commands = append(f.commands, append([]string{name}, args...))
	if message, bad := f.fail[name]; bad {
		return "", &runError{message}
	}
	if out, ok := f.output[name]; ok {
		return out, nil
	}
	return "", nil
}

func (f *fakeRunner) ran(name string, contains string) bool {
	for _, command := range f.commands {
		if command[0] != name {
			continue
		}
		if contains == "" || strings.Contains(strings.Join(command, " "), contains) {
			return true
		}
	}
	return false
}

type runError struct{ message string }

func (e *runError) Error() string { return e.message }

func testEnv(t *testing.T) (Env, *fakeRunner) {
	t.Helper()
	runner := newRunner()
	runner.output["systemd-escape"] = "mnt-shared\n"
	return Env{Root: t.TempDir(), Run: runner, State: NewState()}, runner
}

func read(t *testing.T, env Env, path string) string {
	t.Helper()
	body, err := os.ReadFile(env.Path(path))
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(body)
}

func statuses(results []policy.Result) map[string]string {
	out := map[string]string{}
	for _, result := range results {
		out[result.Setting] = result.Status
	}
	return out
}

// ------------------------------------------------------------------ basics --

func TestFilesAreWrittenWithTheRequestedMode(t *testing.T) {
	env, _ := testEnv(t)
	results := applyFiles(context.Background(), policy.Settings{
		Files: []policy.File{{Path: "/etc/motd", Content: "hello\n", Mode: "0600"}},
	}, env)

	if got := statuses(results)["files:/etc/motd"]; got != "success" {
		t.Fatalf("status = %q", got)
	}
	if body := read(t, env, "/etc/motd"); body != "hello\n" {
		t.Fatalf("content = %q", body)
	}
	info, err := os.Stat(env.Path("/etc/motd"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v (%v)", info.Mode().Perm(), err)
	}
}

func TestWriteFileIsAtomicAndLeavesNoTemporaries(t *testing.T) {
	env, _ := testEnv(t)
	if err := env.WriteFile("/etc/odm/x.conf", "one", 0o644, "", ""); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Dir(env.Path("/etc/odm/x.conf")))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".odm-") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}

func TestSystemdStatesMapToTheRightCommands(t *testing.T) {
	env, runner := testEnv(t)
	applySystemdUnits(context.Background(), policy.Settings{
		SystemdUnits: []policy.SystemdUnit{
			{Unit: "telnet.socket", State: "masked"},
			{Unit: "ssh.service", State: "enabled"},
		},
	}, env)

	if !runner.ran("systemctl", "mask --now telnet.socket") {
		t.Error("telnet.socket was not masked")
	}
	if !runner.ran("systemctl", "enable --now ssh.service") {
		t.Error("ssh.service was not enabled")
	}
}

func TestUnknownSystemdStateIsSkippedNotGuessed(t *testing.T) {
	env, _ := testEnv(t)
	results := applySystemdUnits(context.Background(), policy.Settings{
		SystemdUnits: []policy.SystemdUnit{{Unit: "ssh.service", State: "frobnicated"}},
	}, env)
	if statuses(results)["systemd:ssh.service"] != "skipped" {
		t.Fatalf("results = %+v", results)
	}
}

func TestCronFileNamesAvoidDotsWhichCronIgnores(t *testing.T) {
	env, _ := testEnv(t)
	applyCron(context.Background(), policy.Settings{
		Cron: []policy.CronJob{{Name: "nightly.trim", Schedule: "0 3 * * 0", Command: "/usr/sbin/fstrim -a"}},
	}, env)

	body := read(t, env, "/etc/cron.d/odm-nightly-trim")
	if !strings.Contains(body, "0 3 * * 0 root /usr/sbin/fstrim -a") {
		t.Fatalf("cron entry = %q", body)
	}
}

func TestFirewallBuildsAnIsolatedTable(t *testing.T) {
	env, runner := testEnv(t)
	applyFirewall(context.Background(), policy.Settings{
		Firewall: []policy.Firewall{
			{Name: "ssh", Action: "allow", Protocol: "tcp", Port: 22, Source: "10.0.0.0/8"},
			{Name: "block-smb", Action: "deny", Protocol: "tcp", Port: 445},
		},
	}, env)

	ruleset := read(t, env, firewallPath)
	// A dedicated table means ODM never disturbs rules another tool owns.
	if !strings.Contains(ruleset, "delete table inet odm") {
		t.Error("ruleset does not reset its own table")
	}
	if !strings.Contains(ruleset, "ip saddr 10.0.0.0/8 tcp dport 22 accept") {
		t.Errorf("allow rule missing from:\n%s", ruleset)
	}
	if !strings.Contains(ruleset, "tcp dport 445 drop") {
		t.Errorf("deny rule missing from:\n%s", ruleset)
	}
	if !runner.ran("nft", "-f") {
		t.Error("ruleset was never loaded")
	}
}

// ----------------------------------------------------------------- scripts --

func TestScriptsGetAnInterpreterAndAreExecutable(t *testing.T) {
	env, runner := testEnv(t)
	applyScripts(context.Background(), policy.Settings{
		Scripts: []policy.Script{{Trigger: "startup", Name: "inventory", Content: "id\n"}},
	}, env)

	body := read(t, env, "/etc/odm/scripts/startup/inventory")
	if !strings.HasPrefix(body, "#!/bin/sh\n") {
		t.Fatalf("missing shebang: %q", body)
	}
	info, _ := os.Stat(env.Path("/etc/odm/scripts/startup/inventory"))
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
	if !runner.ran("systemctl", "enable odm-scripts.service") {
		t.Error("startup unit was not enabled")
	}
}

func TestLogonScriptsInstallAPamHookExactlyOnce(t *testing.T) {
	env, _ := testEnv(t)
	if err := env.WriteFile(pamSessionPath, "session required pam_unix.so\n", 0o644, "", ""); err != nil {
		t.Fatal(err)
	}
	settings := policy.Settings{
		Scripts: []policy.Script{{Trigger: "logon", Name: "welcome", Content: "true\n"}},
	}
	applyScripts(context.Background(), settings, env)
	applyScripts(context.Background(), settings, env)

	body := read(t, env, pamSessionPath)
	if strings.Count(body, "pam_exec.so") != 1 {
		t.Fatalf("hook added %d times:\n%s", strings.Count(body, "pam_exec.so"), body)
	}
	if !strings.Contains(body, "session required pam_unix.so") {
		t.Fatalf("existing configuration was lost:\n%s", body)
	}
}

// ------------------------------------------------------------ managed block --

func TestReplaceBlockPreservesEverythingOutsideTheMarkers(t *testing.T) {
	env, _ := testEnv(t)
	original := "# top\nkeep me\n"
	if err := env.WriteFile("/etc/thing.conf", original, 0o644, "", ""); err != nil {
		t.Fatal(err)
	}
	if err := env.ReplaceBlock("/etc/thing.conf", "first\n", 0o644); err != nil {
		t.Fatal(err)
	}
	if err := env.ReplaceBlock("/etc/thing.conf", "second\n", 0o644); err != nil {
		t.Fatal(err)
	}

	body := read(t, env, "/etc/thing.conf")
	if !strings.Contains(body, "keep me") {
		t.Fatalf("outside content lost:\n%s", body)
	}
	if strings.Contains(body, "first") || !strings.Contains(body, "second") {
		t.Fatalf("block not replaced:\n%s", body)
	}
	if strings.Count(body, blockStart) != 1 {
		t.Fatalf("markers duplicated:\n%s", body)
	}
}

func TestEmptyBlockRemovesTheSection(t *testing.T) {
	env, _ := testEnv(t)
	_ = env.WriteFile("/etc/thing.conf", "keep\n", 0o644, "", "")
	_ = env.ReplaceBlock("/etc/thing.conf", "managed\n", 0o644)
	_ = env.ReplaceBlock("/etc/thing.conf", "", 0o644)

	body := read(t, env, "/etc/thing.conf")
	if strings.Contains(body, "managed") || strings.Contains(body, blockStart) {
		t.Fatalf("section not removed:\n%s", body)
	}
	if !strings.Contains(body, "keep") {
		t.Fatalf("outside content lost:\n%s", body)
	}
}

// -------------------------------------------------------------------- sudo --

func TestSudoRuleIsValidatedBeforeInstall(t *testing.T) {
	env, runner := testEnv(t)
	results := applySudo(context.Background(), policy.Settings{
		SudoRules: []policy.SudoRule{{
			Name: "helpdesk", Users: []string{"%Helpdesk"},
			Commands: []string{"/usr/bin/systemctl"}, NoPasswd: true,
		}},
	}, env)

	if !runner.ran("visudo", "-cf") {
		t.Fatal("sudoers file was installed without visudo validation")
	}
	if statuses(results)["sudo:helpdesk"] != "success" {
		t.Fatalf("results = %+v", results)
	}
	body := read(t, env, "/etc/sudoers.d/odm-helpdesk")
	if !strings.Contains(body, "%Helpdesk ALL=(ALL) NOPASSWD: /usr/bin/systemctl") {
		t.Fatalf("rule = %q", body)
	}

	// sudo parses everything in sudoers.d, so the validation candidate must
	// never be staged there.
	entries, err := os.ReadDir(env.Path(sudoersDir))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "odm-helpdesk" {
		names := []string{}
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("unexpected files in sudoers.d: %v", names)
	}
}

func TestInvalidSudoersIsNeverInstalled(t *testing.T) {
	env, runner := testEnv(t)
	runner.fail["visudo"] = "syntax error"

	results := applySudo(context.Background(), policy.Settings{
		SudoRules: []policy.SudoRule{{Name: "broken", Users: []string{"ada"}, Commands: []string{"ALL"}}},
	}, env)

	if statuses(results)["sudo:broken"] != "failed" {
		t.Fatalf("results = %+v", results)
	}
	if _, err := os.Stat(env.Path("/etc/sudoers.d/odm-broken")); !os.IsNotExist(err) {
		t.Fatal("invalid sudoers file was installed anyway")
	}
}

// ------------------------------------------------------------ logon rights --

func TestDenyRulesArePlacedBeforeAllowRules(t *testing.T) {
	env, _ := testEnv(t)
	applyLogonRights(context.Background(), policy.Settings{
		LogonRights: []policy.LogonRight{
			{Principal: "%Engineers", Service: "all", Access: "allow"},
			{Principal: "%Contractors", Service: "all", Access: "deny"},
		},
	}, env)

	body := read(t, env, accessConf)
	deny := strings.Index(body, "-:%Contractors")
	allow := strings.Index(body, "+:%Engineers")
	if deny == -1 || allow == -1 || deny > allow {
		t.Fatalf("pam_access takes the first match, so deny must come first:\n%s", body)
	}
}

func TestAnAllowListNeverLocksOutRoot(t *testing.T) {
	env, _ := testEnv(t)
	applyLogonRights(context.Background(), policy.Settings{
		LogonRights: []policy.LogonRight{
			{Principal: "%Engineers", Service: "all", Access: "allow"},
		},
	}, env)

	body := read(t, env, accessConf)
	closing := strings.Index(body, "-:ALL:ALL")
	keepRoot := strings.Index(body, "+:root")
	if closing == -1 {
		t.Fatalf("allow list has no closing deny:\n%s", body)
	}
	if keepRoot == -1 || keepRoot > closing {
		t.Fatalf("root must stay allowed before the closing deny:\n%s", body)
	}
}

func TestSshUsersAndGroupsUseTheirOwnDirectives(t *testing.T) {
	env, _ := testEnv(t)
	applyLogonRights(context.Background(), policy.Settings{
		LogonRights: []policy.LogonRight{
			{Principal: "%Engineers", Service: "ssh", Access: "allow"},
			{Principal: "contractor1", Service: "ssh", Access: "deny"},
		},
	}, env)

	body := read(t, env, sshdDropIn)
	if !strings.Contains(body, "AllowGroups Engineers sudo") {
		t.Errorf("group allow wrong:\n%s", body)
	}
	if !strings.Contains(body, "DenyUsers contractor1") {
		t.Errorf("user deny wrong:\n%s", body)
	}
	if strings.Contains(body, "AllowGroups contractor1") {
		t.Errorf("a user ended up in a group directive:\n%s", body)
	}
}

// ----------------------------------------------------------------- desktop --

func TestBrowserPolicyGoesToBothVendorLocations(t *testing.T) {
	env, _ := testEnv(t)
	applyBrowser(context.Background(), policy.Settings{
		Browser: &policy.Browser{
			Chromium: map[string]any{"HomepageLocation": "https://intranet.example.org"},
			Firefox:  map[string]any{"Homepage": map[string]any{"URL": "https://intranet.example.org"}},
		},
	}, env)

	for _, path := range chromiumPolicyPaths {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(read(t, env, path)), &parsed); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if parsed["HomepageLocation"] != "https://intranet.example.org" {
			t.Fatalf("%s: %v", path, parsed)
		}
	}

	var firefox map[string]any
	if err := json.Unmarshal([]byte(read(t, env, firefoxPolicyPath)), &firefox); err != nil {
		t.Fatal(err)
	}
	// Firefox requires its settings nested under "policies".
	if _, ok := firefox["policies"]; !ok {
		t.Fatalf("firefox policy not wrapped: %v", firefox)
	}
}

func TestWallpaperWritesADconfDatabaseAndLocksIt(t *testing.T) {
	env, runner := testEnv(t)
	applyWallpaper(context.Background(), policy.Settings{
		Wallpaper: &policy.Wallpaper{URI: "file:///usr/share/backgrounds/corp.png"},
	}, env)

	if profile := read(t, env, dconfProfilePath); !strings.Contains(profile, "system-db:odm") {
		t.Fatalf("profile = %q", profile)
	}
	if keys := read(t, env, dconfKeyfilePath); !strings.Contains(keys, "picture-options='zoom'") {
		t.Fatalf("keyfile = %q", keys)
	}
	if locks := read(t, env, dconfLockPath); !strings.Contains(locks, "picture-uri") {
		t.Fatalf("locks = %q", locks)
	}
	if !runner.ran("dconf", "update") {
		t.Error("dconf database was never rebuilt")
	}
}

// -------------------------------------------------------------- drive maps --

func TestMachineDriveMapUsesKerberosAndNeverStoresCredentials(t *testing.T) {
	env, runner := testEnv(t)
	applyDriveMaps(context.Background(), policy.Settings{
		DriveMaps: []policy.DriveMap{
			{Name: "shared", UNC: "//fs01/shared", MountPoint: "/mnt/shared"},
		},
	}, env)

	unit := read(t, env, "/etc/systemd/system/mnt-shared.mount")
	if !strings.Contains(unit, "sec=krb5") {
		t.Fatalf("mount is not Kerberos-authenticated:\n%s", unit)
	}
	for _, forbidden := range []string{"password", "credentials="} {
		if strings.Contains(unit, forbidden) {
			t.Fatalf("credential material in unit:\n%s", unit)
		}
	}
	if !runner.ran("systemctl", "enable mnt-shared.automount") {
		t.Error("automount unit was not enabled")
	}
}

func TestPerUserDriveMapGoesThroughPamMount(t *testing.T) {
	env, _ := testEnv(t)
	results := applyDriveMaps(context.Background(), policy.Settings{
		DriveMaps: []policy.DriveMap{
			{Name: "home", UNC: "//fs01/home", MountPoint: "/mnt/home", ForPrincipal: "%Engineers"},
		},
	}, env)

	if statuses(results)["drive_maps:pam_mount"] != "success" {
		t.Fatalf("results = %+v", results)
	}
	body := read(t, env, pamMountPath)
	if !strings.Contains(body, `sgrp="Engineers"`) {
		t.Fatalf("group not targeted:\n%s", body)
	}
	if !strings.Contains(body, `server="fs01"`) || !strings.Contains(body, `path="home"`) {
		t.Fatalf("share not parsed:\n%s", body)
	}
}

// ------------------------------------------------------------------- prune --

func TestRemovingASettingRemovesItsFile(t *testing.T) {
	root := t.TempDir()
	runner := newRunner()
	runner.output["systemd-escape"] = "mnt-shared\n"

	first := Env{Root: root, Run: runner, State: NewState()}
	Apply(context.Background(), policy.Settings{
		Files: []policy.File{
			{Path: "/etc/motd", Content: "one"},
			{Path: "/etc/issue", Content: "two"},
		},
	}, first)

	second := Env{Root: root, Run: runner, State: NewState()}
	results := Apply(context.Background(), policy.Settings{
		Files: []policy.File{{Path: "/etc/motd", Content: "one"}},
	}, second)

	if _, err := os.Stat(filepath.Join(root, "etc/issue")); !os.IsNotExist(err) {
		t.Fatal("a file dropped from policy was left on the machine")
	}
	if _, err := os.Stat(filepath.Join(root, "etc/motd")); err != nil {
		t.Fatal("a file still in policy was removed")
	}
	if statuses(results)["removed:/etc/issue"] != "success" {
		t.Fatalf("removal not reported: %+v", results)
	}
}

func TestStateSurvivesARoundTrip(t *testing.T) {
	env, _ := testEnv(t)
	env.State.Own("/etc/motd")
	if err := SaveState(env); err != nil {
		t.Fatal(err)
	}
	if loaded := LoadState(env); !loaded.Owned["/etc/motd"] {
		t.Fatalf("state lost: %+v", loaded)
	}
}

func TestCorruptStateIsIgnoredRatherThanFatal(t *testing.T) {
	env, _ := testEnv(t)
	_ = os.MkdirAll(filepath.Dir(env.Path(StatePath)), 0o750)
	_ = os.WriteFile(env.Path(StatePath), []byte("{not json"), 0o600)

	if loaded := LoadState(env); loaded == nil || loaded.Owned == nil {
		t.Fatal("corrupt state should degrade to an empty state")
	}
}

// ------------------------------------------------------------- user scope --

func TestUserPolicyCannotReconfigureTheMachine(t *testing.T) {
	env, runner := testEnv(t)
	settings := policy.Settings{
		SystemdUnits: []policy.SystemdUnit{{Unit: "ssh.service", State: "stopped"}},
		SudoRules: []policy.SudoRule{
			{Name: "escalate", Users: []string{"mallory"}, Commands: []string{"ALL"}},
		},
		Firewall:  []policy.Firewall{{Name: "open", Action: "allow", Protocol: "tcp", Port: 1}},
		Wallpaper: &policy.Wallpaper{URI: "file:///usr/share/backgrounds/corp.png"},
	}

	results := ApplyUser(context.Background(), settings, env)

	if runner.ran("systemctl", "stop") {
		t.Error("a user policy stopped a system service")
	}
	if _, err := os.Stat(env.Path("/etc/sudoers.d/odm-escalate")); !os.IsNotExist(err) {
		t.Error("a user policy wrote a sudoers rule")
	}
	if _, err := os.Stat(env.Path(firewallPath)); !os.IsNotExist(err) {
		t.Error("a user policy rewrote the firewall")
	}
	if statuses(results)["wallpaper"] != "success" {
		t.Fatalf("user-scoped settings did not apply: %+v", results)
	}
}

func TestUserApplyNeverPrunesMachinePolicy(t *testing.T) {
	root := t.TempDir()
	runner := newRunner()
	runner.output["systemd-escape"] = "mnt-shared\n"

	machine := Env{Root: root, Run: runner, State: NewState()}
	Apply(context.Background(), policy.Settings{
		Files: []policy.File{{Path: "/etc/motd", Content: "managed"}},
	}, machine)

	user := Env{Root: root, Run: runner, State: NewState()}
	ApplyUser(context.Background(), policy.Settings{
		Wallpaper: &policy.Wallpaper{URI: "file:///corp.png"},
	}, user)

	if _, err := os.Stat(filepath.Join(root, "etc/motd")); err != nil {
		t.Fatal("a user login deleted machine policy")
	}
}

func TestSessionHookAppliesUserPolicyWithoutBlockingLogin(t *testing.T) {
	env, _ := testEnv(t)
	applyScripts(context.Background(), policy.Settings{}, env)

	hook := read(t, env, pamHookPath)
	if !strings.Contains(hook, `odm-agent apply --user "$PAM_USER"`) {
		t.Fatalf("hook does not apply user policy:\n%s", hook)
	}
	if !strings.Contains(hook, "timeout 60") {
		t.Fatalf("user apply is not bounded by a timeout:\n%s", hook)
	}
	if !strings.Contains(hook, ">/dev/null 2>&1 &") {
		t.Fatalf("user apply must be backgrounded so a slow API cannot block login:\n%s", hook)
	}
}
