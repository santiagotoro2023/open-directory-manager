package apply

import (
	"context"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func fakeDownload(path string) func(ctx context.Context, dir, packageID string) (string, error) {
	return func(_ context.Context, dir, packageID string) (string, error) {
		full := dir + "/" + packageID + ".deb"
		if path != "" {
			full = path
		}
		return full, nil
	}
}

func TestACustomPackageIsFetchedAndInstalled(t *testing.T) {
	env, runner := testEnv(t)
	env.DownloadPackage = fakeDownload("")

	results := applyCustomPackages(context.Background(), policy.Settings{
		CustomPackages: []policy.CustomPackage{{
			Name: "internal-tool", PackageID: "abc-123",
			PackageName: "odm-internal-tool", Version: "1.0",
		}},
	}, env)

	if len(results) != 1 || results[0].Status != "applied" {
		t.Fatalf("did not apply: %+v", results)
	}
	if !runner.ran("apt-get", "install") {
		t.Error("apt-get install was never run")
	}
}

// The whole point of carrying the version in the policy document is that a
// poll which changes nothing about a package does not fetch a possibly huge
// file it already applied.
func TestAnUnchangedVersionIsNotRefetched(t *testing.T) {
	env, runner := testEnv(t)
	fetched := false
	env.DownloadPackage = func(_ context.Context, _, _ string) (string, error) {
		fetched = true
		return "", nil
	}

	settings := policy.Settings{
		CustomPackages: []policy.CustomPackage{{
			Name: "internal-tool", PackageID: "abc-123",
			PackageName: "odm-internal-tool", Version: "1.0",
		}},
	}
	applyCustomPackages(context.Background(), settings, env)
	fetched = false
	runner.commands = nil

	results := applyCustomPackages(context.Background(), settings, env)

	if fetched {
		t.Error("an unchanged package was fetched again")
	}
	if runner.ran("apt-get", "install") {
		t.Error("an unchanged package was reinstalled")
	}
	if len(results) != 1 || results[0].Status != "unchanged" {
		t.Fatalf("not reported as unchanged: %+v", results)
	}
}

// A new version of the same package id is fetched and installed again.
func TestANewVersionIsFetchedAgain(t *testing.T) {
	env, runner := testEnv(t)
	env.DownloadPackage = fakeDownload("")

	base := policy.CustomPackage{
		Name: "internal-tool", PackageID: "abc-123", PackageName: "odm-internal-tool",
	}
	first := base
	first.Version = "1.0"
	applyCustomPackages(context.Background(), policy.Settings{
		CustomPackages: []policy.CustomPackage{first},
	}, env)
	runner.commands = nil

	second := base
	second.Version = "2.0"
	results := applyCustomPackages(context.Background(), policy.Settings{
		CustomPackages: []policy.CustomPackage{second},
	}, env)

	if !runner.ran("apt-get", "install") {
		t.Error("the new version was not installed")
	}
	if len(results) != 1 || results[0].Status != "applied" {
		t.Fatalf("the new version was not reported as applied: %+v", results)
	}
}

// A package this machine installed for one policy entry has to go when the
// entry is set to absent — and when it simply stops being mentioned at all,
// which is the more common way an operator actually removes one.
func TestRemovingACustomPackageSettingRemovesThePackage(t *testing.T) {
	env, runner := testEnv(t)
	env.DownloadPackage = fakeDownload("")

	install := policy.Settings{CustomPackages: []policy.CustomPackage{{
		Name: "internal-tool", PackageID: "abc-123",
		PackageName: "odm-internal-tool", Version: "1.0",
	}}}
	applyCustomPackages(context.Background(), install, env)
	runner.commands = nil

	results := applyCustomPackages(context.Background(), policy.Settings{}, env)

	if !runner.ran("apt-get", "remove") {
		t.Error("the package was never removed")
	}
	if len(results) != 1 || results[0].Status != "success" {
		t.Fatalf("the removal was not reported cleanly: %+v", results)
	}

	// And a machine that never had one reports nothing on every run of a
	// policy that simply never mentions the setting.
	runner.commands = nil
	if results := applyCustomPackages(context.Background(), policy.Settings{}, env); results != nil {
		t.Errorf("nothing to remove a second time, got: %+v", results)
	}
}

func TestAnExplicitlyAbsentPackageIsRemoved(t *testing.T) {
	env, runner := testEnv(t)
	env.DownloadPackage = fakeDownload("")

	install := policy.Settings{CustomPackages: []policy.CustomPackage{{
		Name: "internal-tool", PackageID: "abc-123",
		PackageName: "odm-internal-tool", Version: "1.0",
	}}}
	applyCustomPackages(context.Background(), install, env)
	runner.commands = nil

	absent := policy.Settings{CustomPackages: []policy.CustomPackage{{
		Name: "internal-tool", PackageID: "abc-123", State: "absent",
	}}}
	results := applyCustomPackages(context.Background(), absent, env)

	if !runner.ran("apt-get", "remove") {
		t.Error("the package was never removed")
	}
	if len(results) != 1 || results[0].Status != "success" {
		t.Fatalf("the removal was not reported cleanly: %+v", results)
	}
}

// An upload that has since been deleted from the console is reported for
// what it is rather than silently skipped or crashing the run.
func TestAnUnavailablePackageIsReportedNotSkipped(t *testing.T) {
	env, _ := testEnv(t)

	results := applyCustomPackages(context.Background(), policy.Settings{
		CustomPackages: []policy.CustomPackage{{
			Name: "internal-tool", PackageID: "abc-123",
			Unavailable: "this package was removed from the console",
		}},
	}, env)

	if len(results) != 1 || results[0].Status != "failed" {
		t.Fatalf("not reported as failed: %+v", results)
	}
}
