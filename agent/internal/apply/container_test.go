package apply

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func markContainer(t *testing.T, env Env) {
	t.Helper()
	marker := env.Path("/etc/odm/container-node")
	if err := os.MkdirAll(filepath.Dir(marker), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, nil, 0o644); err != nil {
		t.Fatal(err)
	}
}

func hostSettings() policy.Settings {
	return policy.Settings{
		Firewall: []policy.Firewall{{Name: "ssh", Action: "accept", Direction: "in", Protocol: "tcp", Port: 22}},
		Sysctl:   []policy.SysctlSetting{{Key: "net.ipv4.ip_forward", Value: "0"}},
		Hostname: &policy.Hostname{Wanted: "renamed"},
		Grub:     &policy.Grub{TimeoutSeconds: 3},
	}
}

func TestAContainerNeverChangesItsHost(t *testing.T) {
	env, runner := testEnv(t)
	markContainer(t, env)
	results := Apply(context.Background(), hostSettings(), env)

	for _, name := range []string{"firewall", "sysctl", "hostname", "grub"} {
		found := false
		for _, result := range results {
			if result.Setting == name {
				found = true
				if result.Status != "skipped" || result.Reason != hostOwnedReason {
					t.Errorf("%s: %s (%s), want skipped as the host's", name, result.Status, result.Reason)
				}
			}
		}
		if !found {
			t.Errorf("%s is not reported at all", name)
		}
	}
	for _, command := range []string{"nft", "sysctl", "hostnamectl", "update-grub", "update-initramfs"} {
		if runner.ran(command, "") {
			t.Errorf("%s ran inside a container", command)
		}
	}
	if _, err := os.Stat(env.Path(firewallPath)); err == nil {
		t.Errorf("a firewall ruleset was written inside a container")
	}
	if _, err := os.Stat(env.Path(sysctlPath)); err == nil {
		t.Errorf("a sysctl file was written inside a container")
	}
}

func TestAContainerSaysNothingAboutHostSettingsNobodyAskedFor(t *testing.T) {
	env, _ := testEnv(t)
	markContainer(t, env)
	for _, result := range Apply(context.Background(), policy.Settings{}, env) {
		if result.Reason == hostOwnedReason {
			t.Errorf("%s reported though no policy sets it", result.Setting)
		}
	}
}

func TestAMachineThatIsNotAContainerStillAppliesThem(t *testing.T) {
	env, runner := testEnv(t)
	Apply(context.Background(), policy.Settings{Firewall: hostSettings().Firewall}, env)
	if !runner.ran("nft", "") {
		t.Errorf("the firewall was not applied on an ordinary machine")
	}
}
