package join

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlanHostnameQualifiesAShortName(t *testing.T) {
	name, err := PlanHostname(Options{Domain: "corp.example.internal", Hostname: "ws01"})
	if err != nil {
		t.Fatal(err)
	}
	if name.Wanted != "ws01.corp.example.internal" {
		t.Fatalf("wanted qualified name, got %q", name.Wanted)
	}
	if name.Short != "ws01" {
		t.Fatalf("short name %q", name.Short)
	}
}

func TestPlanHostnameLeavesAQualifiedNameAlone(t *testing.T) {
	name, err := PlanHostname(Options{
		Domain: "corp.example.internal", Hostname: "ws01.corp.example.internal",
	})
	if err != nil {
		t.Fatal(err)
	}
	if name.Wanted != "ws01.corp.example.internal" {
		t.Fatalf("name changed to %q", name.Wanted)
	}
}

func TestNeedsRenameComparesAgainstTheMachine(t *testing.T) {
	current, _ := os.Hostname()
	name, err := PlanHostname(Options{Domain: "corp.example.internal", Hostname: current})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(current, ".") && name.NeedsRename() {
		t.Fatal("an already-qualified machine should not need renaming")
	}
}

func TestApplyHostnameRewritesHosts(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	original := "127.0.0.1\tlocalhost\n127.0.1.1\tws01\n::1\tlocalhost ip6-localhost\n"
	if err := os.WriteFile(filepath.Join(root, "etc/hosts"), []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	runner := &recordingRunner{output: map[string]string{"hostname": "192.0.2.10 fe80::1\n"}}
	env := Env{Root: root, Run: runner}
	name := MachineName{Current: "ws01", Wanted: "ws01.corp.example.internal", Short: "ws01"}

	if err := ApplyHostname(context.Background(), name, env); err != nil {
		t.Fatal(err)
	}

	body, err := os.ReadFile(filepath.Join(root, "etc/hosts"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(body)
	if strings.Contains(got, "127.0.1.1") {
		t.Fatalf("the short-name line survived:\n%s", got)
	}
	if !strings.Contains(got, "192.0.2.10\tws01.corp.example.internal ws01") {
		t.Fatalf("no address line for the new name:\n%s", got)
	}
	if !strings.Contains(got, "127.0.0.1\tlocalhost") {
		t.Fatalf("localhost was lost:\n%s", got)
	}
	if !runner.ran("hostnamectl set-hostname ws01.corp.example.internal") {
		t.Fatalf("the machine was never renamed; ran %v", runner.calls)
	}

	// Twice must be the same as once.
	if err := ApplyHostname(context.Background(), name, env); err != nil {
		t.Fatal(err)
	}
	again, err := os.ReadFile(filepath.Join(root, "etc/hosts"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(again), "ws01.corp.example.internal") != 1 {
		t.Fatalf("running twice duplicated the entry:\n%s", again)
	}
}

func TestStartServicesRestartsSssd(t *testing.T) {
	runner := &recordingRunner{}
	err := StartServices(context.Background(), Options{}, Env{Root: t.TempDir(), Run: runner})
	if err != nil {
		t.Fatal(err)
	}
	if !runner.ran("systemctl restart sssd") {
		t.Fatalf("sssd was never started; ran %v", runner.calls)
	}
	if !runner.ran("systemctl enable sssd") {
		t.Fatalf("sssd was never enabled; ran %v", runner.calls)
	}
}

type recordingRunner struct {
	calls  []string
	output map[string]string
}

func (r *recordingRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	r.calls = append(r.calls, strings.TrimSpace(name+" "+strings.Join(args, " ")))
	return r.output[name], nil
}

func (r *recordingRunner) RunWithInput(
	ctx context.Context, _ string, name string, args ...string,
) (string, error) {
	return r.Run(ctx, name, args...)
}

func (r *recordingRunner) ran(want string) bool {
	for _, call := range r.calls {
		if call == want {
			return true
		}
	}
	return false
}
