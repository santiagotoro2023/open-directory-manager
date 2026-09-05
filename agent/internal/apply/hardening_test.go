package apply

import (
	"context"
	"os"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func TestSysctlWritesOneSettingPerLineAndAppliesThem(t *testing.T) {
	env, runner := testEnv(t)
	applySysctl(context.Background(), policy.Settings{
		Sysctl: []policy.SysctlSetting{
			{Key: "net.ipv4.ip_forward", Value: "1"},
			{Key: "kernel.kptr_restrict", Value: "2"},
			// The same key twice is one setting; the first wins, so the file
			// cannot contradict itself.
			{Key: "net.ipv4.ip_forward", Value: "0"},
			// Neither of these is a kernel parameter.
			{Key: "not a key", Value: "1"},
			{Key: "vm.swappiness", Value: "10\nkernel.panic = 1"},
		},
	}, env)

	body := read(t, env, sysctlPath)
	if !strings.Contains(body, "net.ipv4.ip_forward = 1") ||
		!strings.Contains(body, "kernel.kptr_restrict = 2") {
		t.Errorf("the good settings were not written:\n%s", body)
	}
	if strings.Contains(body, "ip_forward = 0") {
		t.Error("the same key was written twice")
	}
	if strings.Contains(body, "not a key") || strings.Contains(body, "kernel.panic") {
		t.Errorf("a value that is not a setting reached the file:\n%s", body)
	}
	if !runner.ran("sysctl", "--system") {
		t.Error("the settings were written and never applied")
	}
}

func TestRemovableStorageIsTakenBackWhenThePolicyStopsBlocking(t *testing.T) {
	env, _ := testEnv(t)
	applyRemovableStorage(context.Background(), policy.Settings{
		RemovableStorage: &policy.RemovableStorage{Mode: "block"},
	}, env)
	if read(t, env, removableUdev) == "" {
		t.Fatal("nothing was written")
	}

	applyRemovableStorage(context.Background(), policy.Settings{
		RemovableStorage: &policy.RemovableStorage{Mode: "allow"},
	}, env)
	if _, err := readIfPresent(env, removableUdev); err == nil {
		t.Error("a policy that stopped blocking left the rule behind")
	}
}

func TestAReadOnlyDiskIsMadeReadOnlyBeforeAnythingMountsIt(t *testing.T) {
	env, runner := testEnv(t)
	applyRemovableStorage(context.Background(), policy.Settings{
		RemovableStorage: &policy.RemovableStorage{Mode: "read_only"},
	}, env)
	rule := read(t, env, removableUdev)
	if !strings.Contains(rule, `ATTR{ro}="1"`) {
		t.Errorf("the kernel is not told the device is read-only:\n%s", rule)
	}
	if !runner.ran("udevadm", "--reload") {
		t.Error("udev was not told to re-read its rules")
	}
}

func TestAnExemptGroupNameCannotEscapeThePolkitRule(t *testing.T) {
	// This file runs as JavaScript on every authorisation decision, and the
	// names in it come from the directory.
	rule := removablePolkitRule(policy.RemovableStorage{
		Mode: "block",
		ExemptPrincipals: []string{
			`%Fin"] ; polkit.log("owned"); //`,
			"%Finance",
			"ada",
		},
	})
	if strings.Contains(rule, `polkit.log("owned")`) {
		t.Errorf("a name escaped the string it was in:\n%s", rule)
	}
	if !strings.Contains(rule, `"Finance"`) || !strings.Contains(rule, `"ada"`) {
		t.Errorf("the ordinary names were not kept:\n%s", rule)
	}
	// The leading % is sudoers' way of marking a group, not polkit's.
	if strings.Contains(rule, `"%Finance"`) {
		t.Error("the group marker reached the rule")
	}
}

func TestSoftwareControlAllowsEveryUpgradeAndOnlyListedNewPackages(t *testing.T) {
	env, _ := testEnv(t)
	applySoftwareControl(context.Background(), policy.Settings{
		SoftwareControl: &policy.SoftwareControl{
			Enabled: true,
			Allowed: []string{"firefox-esr", "libreoffice-*", "rm -rf /"},
		},
	}, env)

	names := read(t, env, aptAllowNames)
	if !strings.Contains(names, "firefox-esr") || !strings.Contains(names, "libreoffice-*") {
		t.Errorf("the list is missing what it was given:\n%s", names)
	}
	if strings.Contains(names, "rm -rf") {
		t.Errorf("something that is not a package name reached the list:\n%s", names)
	}

	conf := read(t, env, aptAllowlist)
	if !strings.Contains(conf, "DPkg::Pre-Install-Pkgs") || !strings.Contains(conf, `Version "2"`) {
		t.Errorf("the hook is not wired the way dpkg reads it:\n%s", conf)
	}
	script := read(t, env, aptAllowScript)
	if !strings.Contains(script, `[ "$old" = "-" ] || continue`) {
		t.Errorf("upgrades are not allowed through:\n%s", script)
	}
}

func TestTurningSoftwareControlOffRemovesTheHook(t *testing.T) {
	env, _ := testEnv(t)
	applySoftwareControl(context.Background(), policy.Settings{
		SoftwareControl: &policy.SoftwareControl{Enabled: true, Allowed: []string{"firefox-esr"}},
	}, env)
	applySoftwareControl(context.Background(), policy.Settings{
		SoftwareControl: &policy.SoftwareControl{Enabled: false},
	}, env)
	for _, path := range []string{aptAllowlist, aptAllowScript, aptAllowNames} {
		if _, err := readIfPresent(env, path); err == nil {
			t.Errorf("%s was left behind; nothing could be installed any more", path)
		}
	}
}

func TestAMessageCannotEndTheShellCommandItIsPrintedIn(t *testing.T) {
	// It is printed by a shell, inside double quotes, on a machine where this
	// script runs as root before every install.
	script := allowlistScript(`Ask "; rm -rf /; echo "the desk $(whoami) ` + "`id`" + `\\`)
	line := ""
	for _, candidate := range strings.Split(script, "\n") {
		if strings.Contains(candidate, "odm: Ask") {
			line = candidate
		}
	}
	if line == "" {
		t.Fatalf("the message is not in the script:\n%s", script)
	}
	_, printed, _ := strings.Cut(line, "odm: ")
	printed = strings.TrimSuffix(printed, `" >&2`)
	for _, dangerous := range []string{`"`, "$", "`", "\\"} {
		if strings.Contains(printed, dangerous) {
			t.Errorf("%q survived into the message: %q", dangerous, printed)
		}
	}

	// And an empty one still says something.
	if !strings.Contains(allowlistScript(""), "Ask your administrator") {
		t.Error("no message at all leaves the refusal with nothing to say")
	}
	if !strings.Contains(allowlistScript(`"$`), "Ask your administrator") {
		t.Error("a message that is nothing but punctuation leaves it with nothing to say")
	}
}

// readIfPresent answers rather than failing the test, for the paths a policy
// is supposed to have taken away.
func readIfPresent(env Env, path string) (string, error) {
	body, err := os.ReadFile(env.Path(path))
	return string(body), err
}
