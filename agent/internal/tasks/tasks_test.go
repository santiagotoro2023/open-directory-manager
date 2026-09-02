package tasks

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"odm.example.org/agent/internal/apply"
)

type recordingRunner struct{ commands [][]string }

func (r *recordingRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	r.commands = append(r.commands, append([]string{name}, args...))
	return "", nil
}

func testEnv(t *testing.T) (apply.Env, *recordingRunner) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc/samba"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/samba/smb.conf"), []byte("[global]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{}
	env := apply.NewEnv(root)
	env.Run = runner
	return env, runner
}

func share(name string) map[string]any {
	return map[string]any{
		"name":       name,
		"path":       "/srv/shares/" + name,
		"comment":    "Team files",
		"owner":      "root",
		"group":      "Domain Admins",
		"browseable": true,
		"read_only":  false,
		"acl":        []any{"g:Engineers:rwx", "d:g:Engineers:rwx"},
	}
}

func TestApplyingAShareWritesItsSectionAndAccessList(t *testing.T) {
	env, runner := testEnv(t)

	result := Run(context.Background(), Task{ID: "1", Kind: "share-apply", Payload: share("shared")}, env)
	if !result.OK {
		t.Fatalf("apply failed: %s", result.Output)
	}

	body, err := os.ReadFile(env.Path(SharesConf))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"[shared]", "path = /srv/shares/shared", "vfs objects = acl_xattr"} {
		if !strings.Contains(string(body), want) {
			t.Errorf("share config missing %q:\n%s", want, body)
		}
	}

	var setfacl []string
	for _, command := range runner.commands {
		if command[0] == "setfacl" {
			setfacl = append(setfacl, strings.Join(command, " "))
		}
	}
	if len(setfacl) != 2 {
		t.Fatalf("expected a clear and a set, got %v", setfacl)
	}
	// The existing list is replaced, not added to: what the console shows has
	// to be what the file system enforces.
	if !strings.Contains(setfacl[0], "-b") {
		t.Errorf("access list was not cleared first: %s", setfacl[0])
	}
	if !strings.Contains(setfacl[1], "d:g:Engineers:rwx") {
		t.Errorf("inheritance entry not applied: %s", setfacl[1])
	}
}

func TestASecondShareLeavesTheFirstAlone(t *testing.T) {
	env, _ := testEnv(t)

	Run(context.Background(), Task{ID: "1", Kind: "share-apply", Payload: share("finance")}, env)
	Run(context.Background(), Task{ID: "2", Kind: "share-apply", Payload: share("sales")}, env)

	body, _ := os.ReadFile(env.Path(SharesConf))
	if !strings.Contains(string(body), "[finance]") || !strings.Contains(string(body), "[sales]") {
		t.Fatalf("a share was lost:\n%s", body)
	}
}

func TestRemovingAShareLeavesTheOthers(t *testing.T) {
	env, _ := testEnv(t)
	Run(context.Background(), Task{ID: "1", Kind: "share-apply", Payload: share("finance")}, env)
	Run(context.Background(), Task{ID: "2", Kind: "share-apply", Payload: share("sales")}, env)

	result := Run(context.Background(), Task{
		ID: "3", Kind: "share-remove", Payload: map[string]any{"name": "finance"},
	}, env)
	if !result.OK {
		t.Fatalf("remove failed: %s", result.Output)
	}

	body, _ := os.ReadFile(env.Path(SharesConf))
	if strings.Contains(string(body), "[finance]") {
		t.Errorf("finance is still shared:\n%s", body)
	}
	if !strings.Contains(string(body), "[sales]") {
		t.Errorf("sales was removed too:\n%s", body)
	}
}

func TestRemovingAShareKeepsItsDirectoryUnlessAsked(t *testing.T) {
	env, _ := testEnv(t)
	Run(context.Background(), Task{ID: "1", Kind: "share-apply", Payload: share("finance")}, env)
	path := env.Path("/srv/shares/finance")
	if err := os.WriteFile(filepath.Join(path, "ledger.txt"), []byte("kept"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := Run(context.Background(), Task{
		ID: "2", Kind: "share-remove", Payload: map[string]any{"name": "finance"},
	}, env)
	if !result.OK {
		t.Fatalf("remove failed: %s", result.Output)
	}
	if _, err := os.Stat(filepath.Join(path, "ledger.txt")); err != nil {
		t.Errorf("the contents went with the share: %v", err)
	}
}

func TestRemovingAShareWithItsContentsDeletesTheDirectory(t *testing.T) {
	env, _ := testEnv(t)
	Run(context.Background(), Task{ID: "1", Kind: "share-apply", Payload: share("finance")}, env)
	path := env.Path("/srv/shares/finance")

	result := Run(context.Background(), Task{ID: "2", Kind: "share-remove", Payload: map[string]any{
		"name": "finance", "path": "/srv/shares/finance", "contents": true,
	}}, env)
	if !result.OK {
		t.Fatalf("remove failed: %s", result.Output)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("the directory is still there: %v", err)
	}
}

// The payload is not a reason to delete whatever it names: a task asking for
// a system path is refused on the machine, not only in the control plane.
func TestAShareRemoveWillNotDeleteASystemPath(t *testing.T) {
	env, _ := testEnv(t)
	result := Run(context.Background(), Task{ID: "1", Kind: "share-remove", Payload: map[string]any{
		"name": "etc", "path": "/etc", "contents": true,
	}}, env)
	if result.OK {
		t.Fatalf("a share-remove deleted %s", "/etc")
	}
	if _, err := os.Stat(env.Path("/etc")); err != nil && os.IsNotExist(err) {
		t.Fatal("/etc was removed")
	}
}

func TestSmbConfGainsTheIncludeExactlyOnce(t *testing.T) {
	env, _ := testEnv(t)
	Run(context.Background(), Task{ID: "1", Kind: "share-apply", Payload: share("a")}, env)
	Run(context.Background(), Task{ID: "2", Kind: "share-apply", Payload: share("b")}, env)

	body, _ := os.ReadFile(env.Path("/etc/samba/smb.conf"))
	if got := strings.Count(string(body), "include = "+SharesConf); got != 1 {
		t.Fatalf("include appears %d times:\n%s", got, body)
	}
}

func TestHostileValuesNeverReachTheFileSystem(t *testing.T) {
	env, runner := testEnv(t)

	for _, payload := range []map[string]any{
		{"name": "ok", "path": "/srv/../etc", "acl": []any{}},
		{"name": "ok", "path": "/etc", "acl": []any{}},
		{"name": "a]\n[global", "path": "/srv/x", "acl": []any{}},
		{"name": "ok", "path": "/srv/x", "acl": []any{"g:x:rwx; rm -rf /"}},
	} {
		result := Run(context.Background(), Task{ID: "1", Kind: "share-apply", Payload: payload}, env)
		if result.OK {
			t.Errorf("accepted %v", payload)
		}
	}
	for _, command := range runner.commands {
		if command[0] == "setfacl" {
			t.Errorf("a rejected share still ran %v", command)
		}
	}
}

func TestAnUnknownRoleInstallerIsRefusedRatherThanExecuted(t *testing.T) {
	env, runner := testEnv(t)

	result := Run(context.Background(), Task{
		ID:      "1",
		Kind:    "role-install",
		Payload: map[string]any{"role": "dhcp; rm -rf /", "arguments": []any{}},
	}, env)
	if result.OK {
		t.Fatal("a role name with a shell metacharacter was accepted")
	}
	if len(runner.commands) != 0 {
		t.Fatalf("something ran anyway: %v", runner.commands)
	}
}

func TestAnUnknownTaskKindFailsLoudly(t *testing.T) {
	env, _ := testEnv(t)
	result := Run(context.Background(), Task{ID: "1", Kind: "reboot-everything"}, env)
	if result.OK {
		t.Fatal("an unknown kind was reported as done")
	}
}

func TestAPackageThatKeepsTheMachineManagedIsNotRemovable(t *testing.T) {
	env, runner := testEnv(t)

	for _, name := range []string{"odm-agent", "sssd", "systemd", "sudo"} {
		result := Run(context.Background(), Task{
			ID: "1", Kind: "package-remove", Payload: map[string]any{"package": name},
		}, env)
		if result.OK {
			t.Errorf("%s was accepted for removal", name)
		}
	}
	for _, command := range runner.commands {
		if command[0] == "apt-get" {
			t.Errorf("apt ran for a refused removal: %v", command)
		}
	}
}

func TestHostilePackageNamesNeverReachApt(t *testing.T) {
	env, runner := testEnv(t)

	for _, name := range []string{"curl; rm -rf /", "$(id)", "../etc", "UPPER", ""} {
		if result := Run(context.Background(), Task{
			ID: "1", Kind: "package-install", Payload: map[string]any{"package": name},
		}, env); result.OK {
			t.Errorf("accepted %q", name)
		}
	}
	if len(runner.commands) != 0 {
		t.Fatalf("something ran anyway: %v", runner.commands)
	}
}

func TestRemovingAPackageDoesNotPurgeItsConfiguration(t *testing.T) {
	env, runner := testEnv(t)

	result := Run(context.Background(), Task{
		ID: "1", Kind: "package-remove", Payload: map[string]any{"package": "wireshark"},
	}, env)
	if !result.OK {
		t.Fatalf("removal failed: %s", result.Output)
	}
	var ran []string
	for _, command := range runner.commands {
		if command[0] == "apt-get" {
			ran = command
		}
	}
	if len(ran) == 0 {
		t.Fatal("apt-get never ran")
	}
	// "uninstall" on a button does not mean "delete the configuration too".
	for _, argument := range ran {
		if argument == "purge" {
			t.Errorf("purge was used: %v", ran)
		}
	}
}

func TestRestartIsScheduledRatherThanImmediate(t *testing.T) {
	env, runner := testEnv(t)

	result := Run(context.Background(), Task{ID: "1", Kind: "restart"}, env)
	if !result.OK {
		t.Fatalf("restart failed: %s", result.Output)
	}
	// An immediate reboot kills the process before it can report success.
	var found bool
	for _, command := range runner.commands {
		if command[0] == "shutdown" && command[1] == "-r" && command[2] == "+1" {
			found = true
		}
	}
	if !found {
		t.Errorf("reboot was not scheduled a minute out: %v", runner.commands)
	}
}

func TestIncludeGoesIntoGlobal(t *testing.T) {
	// Appended to the end of the file the include lands inside [netlogon],
	// which is the last section on a domain controller.
	conf := "[global]\n\trealm = CORP\n\n[netlogon]\n\tpath = /var/lib/samba\n"
	got := insertIntoGlobal(conf, "\ninclude = "+SharesConf+"\n")
	global, _, ok := strings.Cut(got, "[netlogon]")
	if !ok || !strings.Contains(global, "include = "+SharesConf) {
		t.Fatalf("include is not in [global]:\n%s", got)
	}
}

// /srv/shares itself got the share's 2770, so nothing could traverse into the
// share it contained: published, correct access list, "Permission denied".
func TestAShareIsReachableThroughItsParents(t *testing.T) {
	root := t.TempDir()
	env := apply.Env{Root: root, Run: &recordingRunner{}, State: apply.NewState()}
	if err := os.MkdirAll(filepath.Join(root, "etc/samba"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "etc/samba/smb.conf"), []byte("[global]\n"), 0o644,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := applyShare(context.Background(), map[string]any{
		"name": "Profiles", "path": "/srv/shares/profiles", "owner": "root",
		"group": "root", "acl": []any{}, "browseable": true,
	}, env); err != nil {
		t.Fatalf("applying the share: %v", err)
	}
	for _, path := range []string{"/srv", "/srv/shares"} {
		info, err := os.Stat(filepath.Join(root, path))
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if info.Mode().Perm()&0o005 != 0o005 {
			t.Fatalf("%s is %o; nobody can traverse into the share", path, info.Mode().Perm())
		}
	}
}
