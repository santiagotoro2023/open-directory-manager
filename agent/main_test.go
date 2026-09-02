package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"odm.example.org/agent/internal/apply"
)

// The interval is a domain setting, and a machine that misreads it stops
// asking the control plane anything at all. Every route into it has to end
// with the agent still polling.
func TestTheRefreshIntervalIsAlwaysUsable(t *testing.T) {
	for _, test := range []struct {
		name  string
		saved string
		want  time.Duration
	}{
		{"nothing written yet", "", 15 * time.Minute},
		{"what the domain said", "5", 5 * time.Minute},
		{"the shortest interval", "1", time.Minute},
		{"a trailing newline", "30\n", 30 * time.Minute},
		{"not a number", "soon", 15 * time.Minute},
		{"zero", "0", 15 * time.Minute},
		{"negative", "-5", 15 * time.Minute},
		{"longer than a day", "100000", 24 * time.Hour},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			if test.saved != "" {
				write(t, filepath.Join(root, refreshPath), test.saved)
			}
			got := refreshInterval(apply.NewEnv(root), filepath.Join(root, "absent.json"))
			if got != test.want {
				t.Fatalf("interval = %s, want %s", got, test.want)
			}
		})
	}
}

// What domain join wrote, for a machine that has not reached the control
// plane yet.
func TestTheConfiguredIntervalIsTheFallback(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "agent.json")
	write(t, configPath, `{"api_url":"https://odm.example.org","service_principal":"HTTP/odm.example.org",`+
		`"keytab":"/etc/krb5.keytab","realm":"EXAMPLE.ORG","refresh_minutes":5}`)

	if got := refreshInterval(apply.NewEnv(root), configPath); got != 5*time.Minute {
		t.Fatalf("interval = %s, want 5m", got)
	}

	// And once the domain has said otherwise, the domain wins.
	saveRefresh(apply.NewEnv(root), 30)
	if got := refreshInterval(apply.NewEnv(root), configPath); got != 30*time.Minute {
		t.Fatalf("interval = %s, want 30m", got)
	}
}

// A document that carries no interval must not erase the one the machine is
// already using.
func TestAnEmptyIntervalLeavesTheLastOneAlone(t *testing.T) {
	root := t.TempDir()
	env := apply.NewEnv(root)
	saveRefresh(env, 5)
	saveRefresh(env, 0)
	if got := refreshInterval(env, filepath.Join(root, "absent.json")); got != 5*time.Minute {
		t.Fatalf("interval = %s, want 5m", got)
	}
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}
