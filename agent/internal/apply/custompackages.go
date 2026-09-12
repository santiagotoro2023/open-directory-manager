package apply

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Software deployment beyond what an apt repository carries (CLAUDE.md §3.5):
// a .deb an operator uploaded directly to the console, fetched from there and
// installed the way `apt-get install ./file.deb` would — apt resolves
// whatever it depends on, the same as any other package.
const (
	customPackageStatePath = "/var/lib/odm/custom-packages.json"
	customPackageCacheDir  = "/var/lib/odm/packages"
)

// customPackageState is what this machine has installed through a policy
// object, keyed by the console's own id for the upload rather than by the
// name inside it — a name an operator is free to reuse for a different
// upload later, in which case it is a different package as far as this
// machine's own record of what it put there is concerned.
type customPackageState struct {
	Installed map[string]installedPackage `json:"installed,omitempty"`
}

type installedPackage struct {
	PackageName string `json:"package_name"`
	Version     string `json:"version"`
}

func loadCustomPackageState(env Env) customPackageState {
	state := customPackageState{Installed: map[string]installedPackage{}}
	raw, err := os.ReadFile(env.Path(customPackageStatePath))
	if err != nil {
		return state
	}
	if err := json.Unmarshal(raw, &state); err != nil || state.Installed == nil {
		return customPackageState{Installed: map[string]installedPackage{}}
	}
	return state
}

func saveCustomPackageState(env Env, state customPackageState) {
	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return
	}
	path := env.Path(customPackageStatePath)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return
	}
	_ = os.WriteFile(path, append(body, '\n'), 0o600)
}

func applyCustomPackages(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	state := loadCustomPackageState(env)
	if len(s.CustomPackages) == 0 && len(state.Installed) == 0 {
		return nil
	}

	var results []policy.Result
	wanted := map[string]bool{}

	for _, pkg := range s.CustomPackages {
		setting := "custom_packages:" + pkg.Name

		if pkg.Unavailable != "" {
			results = append(results, policy.Result{
				Setting: setting, Status: "failed", Reason: pkg.Unavailable,
			})
			continue
		}

		if pkg.State == "absent" {
			if result, ok := removeCustomPackage(ctx, env, &state, pkg.PackageID, setting); ok {
				results = append(results, result)
			}
			continue
		}

		wanted[pkg.PackageID] = true
		if installed, ok := state.Installed[pkg.PackageID]; ok &&
			installed.PackageName == pkg.PackageName && installed.Version == pkg.Version {
			results = append(results, policy.Result{
				Setting: setting, Status: "unchanged",
				Reason: fmt.Sprintf("%s %s already installed", pkg.PackageName, pkg.Version),
			})
			continue
		}

		if env.DownloadPackage == nil || env.Run == nil {
			results = append(results, policy.Fail(setting, fmt.Errorf("no way to fetch or install packages")))
			continue
		}
		path, err := env.DownloadPackage(ctx, env.Path(customPackageCacheDir), pkg.PackageID)
		if err != nil {
			results = append(results, policy.Fail(setting, fmt.Errorf("fetching %s: %w", pkg.Name, err)))
			continue
		}
		// Not --no-install-recommends here: unlike a named apt package, an
		// operator uploading a .deb by hand usually means everything it asks
		// for, the way running the installer themselves would.
		out, err := env.Run.Run(ctx, "apt-get", "-y",
			"-o", "Dpkg::Options::=--force-confold", "install", path)
		_ = os.Remove(path) // dpkg's own database is the record now, not a second copy of the file
		if err != nil {
			results = append(results, policy.Result{
				Setting: setting, Status: "failed",
				Reason: fmt.Sprintf("installing %s: %v: %s", pkg.PackageName, err,
					strings.TrimSpace(lastLine(out))),
			})
			continue
		}
		state.Installed[pkg.PackageID] = installedPackage{
			PackageName: pkg.PackageName, Version: pkg.Version,
		}
		results = append(results, policy.Result{
			Setting: setting, Status: "applied",
			Reason: fmt.Sprintf("%s %s installed", pkg.PackageName, pkg.Version),
		})
	}

	// Named by a policy object once and not any more — not turned to absent,
	// simply no longer mentioned. An operator who deletes the entry rather
	// than flipping its state to absent expects the same result: the package
	// this machine only has because of that entry goes with it.
	for id, installed := range state.Installed {
		if wanted[id] {
			continue
		}
		setting := "custom_packages:" + installed.PackageName
		if result, ok := removeCustomPackage(ctx, env, &state, id, setting); ok {
			results = append(results, result)
		}
	}

	saveCustomPackageState(env, state)
	return results
}

// removeCustomPackage takes back a package this machine's own record shows
// it installed for one policy entry. Nothing is done, and ok is false, for
// an id this machine never installed — never true of an id still in
// s.CustomPackages, since state is what decides whether there is anything to
// remove in the first place.
func removeCustomPackage(
	ctx context.Context, env Env, state *customPackageState, packageID, setting string,
) (policy.Result, bool) {
	installed, ok := state.Installed[packageID]
	if !ok {
		return policy.Result{}, false
	}
	if env.Run != nil {
		if out, err := env.Run.Run(ctx, "apt-get", "-y", "remove", installed.PackageName); err != nil {
			return policy.Result{
				Setting: setting, Status: "failed",
				Reason: fmt.Sprintf("removing %s: %v: %s", installed.PackageName, err,
					strings.TrimSpace(lastLine(out))),
			}, true
		}
	}
	delete(state.Installed, packageID)
	return policy.Result{
		Setting: setting, Status: "success",
		Reason: installed.PackageName + " removed: no longer in policy",
	}, true
}
