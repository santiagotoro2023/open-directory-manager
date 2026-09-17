package apply

import (
	"context"
	"os/exec"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

const fakeReleases = `[
 {"tag_name":"cli-v2025.9.0","assets":[{"name":"bw-linux-2025.9.0.zip","browser_download_url":"https://github.com/bitwarden/clients/releases/download/cli-v2025.9.0/bw-linux-2025.9.0.zip"}]},
 {"tag_name":"desktop-v2025.9.1","prerelease":true,"assets":[{"name":"Bitwarden-2025.9.1-amd64.deb","browser_download_url":"https://github.com/bitwarden/clients/releases/download/desktop-v2025.9.1/Bitwarden-2025.9.1-amd64.deb"}]},
 {"tag_name":"desktop-v2025.8.2","assets":[
   {"name":"Bitwarden-2025.8.2-x86_64.AppImage","browser_download_url":"https://github.com/bitwarden/clients/releases/download/desktop-v2025.8.2/Bitwarden-2025.8.2-x86_64.AppImage"},
   {"name":"Bitwarden-2025.8.2-amd64.deb","browser_download_url":"https://github.com/bitwarden/clients/releases/download/desktop-v2025.8.2/Bitwarden-2025.8.2-amd64.deb"}]}
]`

func TestTheDesktopAppIsInstalledFromItsOwnReleaseAndPointedAtTheVault(t *testing.T) {
	env, run := testEnv(t)
	run.output["curl"] = fakeReleases
	settings := policy.Settings{PasswordManager: &policy.PasswordManager{
		VaultURL: "https://vault.corp.example.internal", DesktopApp: true,
	}}
	results := applyPasswordManager(context.Background(), settings, env)
	if len(results) != 1 || results[0].Status != "applied" {
		t.Fatalf("results: %+v", results)
	}
	if !run.ran("curl", "desktop-v2025.8.2/Bitwarden-2025.8.2-amd64.deb") {
		t.Errorf("the stable desktop .deb was not fetched: %v", run.commands)
	}
	if !run.ran("apt-get", "install") || run.ran("curl", "2025.9.1") {
		t.Errorf("commands: %v", run.commands)
	}
	if loadPasswordManagerState(env).Installed != "2025.8.2" {
		t.Error("the installed version is not recorded")
	}

	hook := read(t, env, bitwardenFirstRun)
	if strings.Contains(hook, `[ "" `) {
		t.Error("a variable went missing from the hook")
	}
	if !strings.Contains(hook, `"base": "https://vault.corp.example.internal"`) {
		t.Errorf("the hook does not point at the vault:\n%s", hook)
	}
	if sh, err := exec.LookPath("sh"); err == nil {
		if out, err := exec.Command(sh, "-n", env.Path(bitwardenFirstRun)).CombinedOutput(); err != nil {
			t.Fatalf("the hook does not parse: %s", out)
		}
	}
	if !strings.Contains(read(t, env, bitwardenAutostart), "Exec="+bitwardenFirstRun) {
		t.Error("the hook is not run at sign-in")
	}

	// A second pass within the day asks nothing and changes nothing.
	run.commands = nil
	results = applyPasswordManager(context.Background(), settings, env)
	if results[len(results)-1].Status != "unchanged" || run.ran("curl", "") {
		t.Errorf("second pass: %+v %v", results, run.commands)
	}

	// The setting gone: the app goes, the hook is pruned by the state.
	run.commands = nil
	results = applyPasswordManager(context.Background(), policy.Settings{}, env)
	if len(results) != 1 || results[0].Status != "success" || !run.ran("apt-get", "remove bitwarden") {
		t.Errorf("removal: %+v %v", results, run.commands)
	}
	if loadPasswordManagerState(env).Installed != "" {
		t.Error("still recorded as installed")
	}
	if results := applyPasswordManager(context.Background(), policy.Settings{}, env); results != nil {
		t.Errorf("nothing to do, but: %+v", results)
	}
}

func TestTheDesktopAppNeedsAVault(t *testing.T) {
	env, _ := testEnv(t)
	settings := policy.Settings{PasswordManager: &policy.PasswordManager{DesktopApp: true}}
	results := applyPasswordManager(context.Background(), settings, env)
	if len(results) != 1 || results[0].Status != "failed" {
		t.Fatalf("results: %+v", results)
	}
}
