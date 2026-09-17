package apply

import (
	"context"
	"os"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func TestARenameAsksTheConsoleFirstThenChangesTheMachine(t *testing.T) {
	env, run := testEnv(t)
	current, _ := os.Hostname()
	asked := ""
	env.Rename = func(_ context.Context, hostname string) (string, []byte, error) {
		asked = hostname
		return hostname + ".corp.example.internal", []byte("KEYTAB"), nil
	}
	env.KeytabPath = "/etc/krb5.keytab"
	_ = os.MkdirAll(env.Path("/etc"), 0o755)
	_ = os.WriteFile(env.Path("/etc/hosts"), []byte("127.0.0.1\tlocalhost\n192.168.1.14\t"+current+".corp.example.internal "+current+"\n"), 0o644)

	results := applyHostname(context.Background(), policy.Settings{Hostname: &policy.Hostname{Wanted: "ws-0042"}}, env)
	if len(results) != 1 || results[0].Status != "success" {
		t.Fatalf("results: %+v", results)
	}
	if asked != "ws-0042" {
		t.Fatalf("asked the console for %q", asked)
	}
	if keytab, _ := os.ReadFile(env.Path("/etc/krb5.keytab")); string(keytab) != "KEYTAB" {
		t.Error("the new keytab was not written")
	}
	hosts, _ := os.ReadFile(env.Path("/etc/hosts"))
	if !strings.Contains(string(hosts), "192.168.1.14\tws-0042.corp.example.internal ws-0042") || strings.Contains(string(hosts), current+".corp") {
		t.Errorf("/etc/hosts:\n%s", hosts)
	}
	if !run.ran("hostnamectl", "set-hostname ws-0042.corp.example.internal") || !run.ran("systemctl", "restart sssd") || !run.ran("systemd-run", "restart odm-agent") {
		t.Errorf("commands: %v", run.commands)
	}
}

func TestAMachineAlreadyNamedOrCarryingRolesIsLeftAlone(t *testing.T) {
	env, run := testEnv(t)
	current, _ := os.Hostname()
	env.Rename = func(_ context.Context, hostname string) (string, []byte, error) {
		t.Fatal("the console must not be asked")
		return "", nil, nil
	}
	short := strings.SplitN(current, ".", 2)[0]
	results := applyHostname(context.Background(), policy.Settings{Hostname: &policy.Hostname{Wanted: short}}, env)
	if len(results) != 1 || results[0].Status != "success" {
		t.Fatalf("a machine with the right name already: %+v", results)
	}
	_ = os.MkdirAll(env.Path("/var/lib/samba/private"), 0o755)
	_ = os.WriteFile(env.Path("/var/lib/samba/private/sam.ldb"), []byte(""), 0o644)
	results = applyHostname(context.Background(), policy.Settings{Hostname: &policy.Hostname{Wanted: "ws-0001"}}, env)
	if len(results) != 1 || results[0].Status != "skipped" {
		t.Fatalf("a domain controller: %+v", results)
	}
	if run.ran("hostnamectl", "") {
		t.Error("nothing should have been renamed")
	}
}
