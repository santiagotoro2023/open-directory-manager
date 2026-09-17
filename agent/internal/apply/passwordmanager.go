package apply

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"odm.example.org/agent/internal/policy"
)

// The password manager's desktop app: Bitwarden's own Linux build, the .deb
// from its release, installed the way an uploaded package is and taken back
// when the setting goes. The browser extension is not this applier's — the
// control plane turns that half of the setting into native browser policy,
// and the browsers install and remove the extension themselves as that
// policy comes and goes.
//
// A machine also hands the app the vault's address: Bitwarden keeps its
// settings per person, so a file written at each person's first sign-in
// after the app arrived points their copy at the domain's vault before it
// ever asks for a server. Removing the setting removes the app and the
// hook, and leaves a person's own data file alone — it holds their
// session, which is theirs.
const (
	bitwardenReleases  = "https://api.github.com/repos/bitwarden/clients/releases?per_page=40"
	bitwardenStatePath = "/var/lib/odm/password-manager.json"
	bitwardenPackage   = "bitwarden"
	bitwardenFirstRun  = "/usr/lib/odm/bitwarden-first-run"
	bitwardenAutostart = "/etc/xdg/autostart/odm-password-manager.desktop"
	// How often to ask GitHub whether there is a newer desktop app. The
	// policy is applied every quarter of an hour; a fleet asking a public
	// API that often would be a nuisance for no benefit.
	bitwardenCheckEvery = 24 * time.Hour
)

var bitwardenVersionRE = regexp.MustCompile(`^[0-9]{4}\.[0-9]+\.[0-9]+$`)

type passwordManagerState struct {
	// The version this machine installed; empty when the app is not ours.
	Installed string    `json:"installed,omitempty"`
	Checked   time.Time `json:"checked,omitempty"`
}

func loadPasswordManagerState(env Env) passwordManagerState {
	var state passwordManagerState
	raw, err := os.ReadFile(env.Path(bitwardenStatePath))
	if err == nil {
		_ = json.Unmarshal(raw, &state)
	}
	return state
}

func savePasswordManagerState(env Env, state passwordManagerState) {
	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return
	}
	path := env.Path(bitwardenStatePath)
	_ = os.MkdirAll(filepath.Dir(path), 0o750)
	_ = os.WriteFile(path, append(body, '\n'), 0o600)
}

func applyPasswordManager(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	state := loadPasswordManagerState(env)
	wanted := s.PasswordManager != nil && s.PasswordManager.DesktopApp
	if !wanted {
		if state.Installed == "" {
			return nil
		}
		// Named by policy once and not any more: the app this machine only
		// has because of the setting goes with it.
		if env.Run != nil {
			if out, err := Unsandboxed(ctx, env, "apt-get", "-y", "remove", bitwardenPackage); err != nil {
				return []policy.Result{{
					Setting: "password_manager:desktop_app", Status: "failed",
					Reason: fmt.Sprintf("removing %s: %v: %s", bitwardenPackage, err, strings.TrimSpace(lastLine(out))),
				}}
			}
		}
		savePasswordManagerState(env, passwordManagerState{})
		return []policy.Result{{
			Setting: "password_manager:desktop_app", Status: "success",
			Reason: "the desktop app removed: no longer in policy",
		}}
	}

	setting := "password_manager:desktop_app"
	var results []policy.Result
	if s.PasswordManager.VaultURL == "" {
		return []policy.Result{{
			Setting: setting, Status: "failed",
			Reason: "no vault to point at: install the password-manager role, or give a vault address",
		}}
	}

	// The first-run hook: at a sign-in, a person whose copy of the app has
	// no settings yet gets one pointed at the vault. Bitwarden's data file
	// is JSON it rewrites itself; only ever created here, never edited.
	hook := "#!/bin/sh\n" + Header + `# Points a person's Bitwarden desktop app at the domain's vault, once.
DATA="$HOME/.config/Bitwarden/data.json"
[ -e "$DATA" ] && exit 0
mkdir -p "$HOME/.config/Bitwarden" || exit 0
cat > "$DATA" <<'JSON'
` + bitwardenSeed(s.PasswordManager.VaultURL) + `
JSON
`
	if err := env.WriteFile(bitwardenFirstRun, hook, 0o755, "root", "root"); err != nil {
		return []policy.Result{policy.Fail(setting, err)}
	}
	autostart := Header + `[Desktop Entry]
Type=Application
Name=Password manager setup
Comment=Points the password manager at the domain's vault
Exec=` + bitwardenFirstRun + `
NoDisplay=true
X-GNOME-Autostart-Phase=Initialization
`
	if err := env.WriteFile(bitwardenAutostart, autostart, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail(setting, err)}
	}

	if env.Run == nil {
		return append(results, policy.Result{Setting: setting, Status: "skipped", Reason: "no way to install packages"})
	}
	if state.Installed != "" && time.Since(state.Checked) < bitwardenCheckEvery {
		return append(results, policy.Result{
			Setting: setting, Status: "unchanged", Reason: "Bitwarden " + state.Installed + " installed",
		})
	}
	version, asset, err := latestBitwardenDesktop(ctx, env)
	if err != nil {
		if state.Installed != "" {
			// Installed, and the release page unreachable just now: still
			// what the policy asked for.
			return append(results, policy.Result{
				Setting: setting, Status: "unchanged",
				Reason: fmt.Sprintf("Bitwarden %s installed; could not check for newer: %v", state.Installed, err),
			})
		}
		return append(results, policy.Fail(setting, err))
	}
	if state.Installed == version {
		state.Checked = time.Now()
		savePasswordManagerState(env, state)
		return append(results, policy.Result{
			Setting: setting, Status: "unchanged", Reason: "Bitwarden " + version + " installed",
		})
	}
	dir := env.Path(customPackageCacheDir)
	_ = os.MkdirAll(dir, 0o755)
	path := filepath.Join(dir, "bitwarden-"+version+".deb")
	if out, err := Unsandboxed(ctx, env, "curl", "-fsSL", "-o", path, asset); err != nil {
		return append(results, policy.Result{
			Setting: setting, Status: "failed",
			Reason: fmt.Sprintf("fetching %s: %v: %s", asset, err, strings.TrimSpace(lastLine(out))),
		})
	}
	out, err := Unsandboxed(ctx, env, "apt-get", "-y", "-o", "Dpkg::Options::=--force-confold", "install", path)
	_ = os.Remove(path)
	if err != nil {
		return append(results, policy.Result{
			Setting: setting, Status: "failed",
			Reason: fmt.Sprintf("installing Bitwarden %s: %v: %s", version, err, strings.TrimSpace(lastLine(out))),
		})
	}
	savePasswordManagerState(env, passwordManagerState{Installed: version, Checked: time.Now()})
	return append(results, policy.Result{
		Setting: setting, Status: "applied", Reason: "Bitwarden " + version + " installed",
	})
}

// bitwardenSeed is the desktop app's own settings file with nothing in it
// but the server: the shape the app writes for "self-hosted" itself.
func bitwardenSeed(vaultURL string) string {
	body, _ := json.MarshalIndent(map[string]any{
		"global_environment_environment": map[string]any{
			"region": "Self-hosted",
			"urls": map[string]any{
				"base": vaultURL, "api": nil, "identity": nil, "icons": nil,
				"notifications": nil, "events": nil, "webVault": nil, "keyConnector": nil,
			},
		},
	}, "", "  ")
	return string(body)
}

// latestBitwardenDesktop finds the newest desktop release and its Debian
// package: the clients repository releases every client under its own tag
// prefix, so "latest" alone would as often be the CLI or the extension.
func latestBitwardenDesktop(ctx context.Context, env Env) (version, asset string, err error) {
	out, err := env.Run.Run(ctx, "curl", "-fsSL", "-H", "Accept: application/vnd.github+json", bitwardenReleases)
	if err != nil {
		return "", "", fmt.Errorf("finding Bitwarden's latest desktop release: %w", err)
	}
	var releases []struct {
		Tag        string `json:"tag_name"`
		Prerelease bool   `json:"prerelease"`
		Draft      bool   `json:"draft"`
		Assets     []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal([]byte(out), &releases); err != nil {
		return "", "", fmt.Errorf("reading Bitwarden's releases: %w", err)
	}
	for _, release := range releases {
		if release.Prerelease || release.Draft || !strings.HasPrefix(release.Tag, "desktop-v") {
			continue
		}
		version := strings.TrimPrefix(release.Tag, "desktop-v")
		if !bitwardenVersionRE.MatchString(version) {
			continue
		}
		for _, a := range release.Assets {
			if strings.HasPrefix(a.Name, "Bitwarden-") && strings.HasSuffix(a.Name, "-amd64.deb") &&
				strings.HasPrefix(a.URL, "https://github.com/bitwarden/clients/releases/download/") {
				return version, a.URL, nil
			}
		}
	}
	return "", "", fmt.Errorf("no desktop release with a Debian package among the latest releases")
}
