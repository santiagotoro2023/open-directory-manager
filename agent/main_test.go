package main

import (
	"os"
	"path/filepath"
	"strings"
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

// Every applier that writes into a home directory has to be called from the
// session path, and one of them was not: Shortcuts had a schema, an applier,
// an editor and a wiki section, and did nothing at all, because nothing ever
// called it. A test of the applier does not catch that; a test of the wiring
// does.
func TestEverySessionApplierIsActuallyCalled(t *testing.T) {
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(source)
	for _, deployer := range []string{
		"apply.MountDriveMaps",
		"apply.DeployRemoteDesktopFiles",
		"apply.DeployShortcuts",
		"apply.DeployDash",
		"apply.ApplyPhoto",
	} {
		if !strings.Contains(body, deployer+"(") {
			t.Errorf("%s is never called, so the setting it applies does nothing", deployer)
		}
	}
}

func TestEnrolmentsAreFetchedEvenWhenNoPolicyChanged(t *testing.T) {
	// Somebody enrolling changes no policy object and no serial. Fetched
	// after the unchanged check, the machine never heard about it: a person
	// who had scanned the QR code was still let in on their password alone,
	// for as long as nobody edited a policy object.
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(source)
	fetch := strings.Index(body, "enrolments = fetchSecondFactor(")
	unchanged := strings.Index(body, `fmt.Println("policy unchanged")`)
	if fetch < 0 || unchanged < 0 {
		t.Fatal("the unchanged path or the enrolment fetch has moved")
	}
	if fetch > unchanged {
		t.Error("enrolments are fetched only when the policy changed")
	}
}

func TestAFailedRunIsTriedAgainSoon(t *testing.T) {
	// A controller whose console was still starting waited a quarter of an
	// hour before saying anything about itself, and the console said it had
	// never been heard from.
	interval := 15 * time.Minute
	if got := afterFailures(interval, 0); got != interval {
		t.Fatalf("a run that worked should wait the interval, got %s", got)
	}
	if got := afterFailures(interval, 1); got != 30*time.Second {
		t.Fatalf("first failure should retry soon, got %s", got)
	}
	if got := afterFailures(interval, 2); got != time.Minute {
		t.Fatalf("second failure should back off, got %s", got)
	}
	// However long it goes on, never longer than the ordinary interval.
	if got := afterFailures(interval, 40); got != interval {
		t.Fatalf("backoff should stop at the interval, got %s", got)
	}
	if got := afterFailures(time.Minute, 5); got != time.Minute {
		t.Fatalf("backoff should never exceed a short interval, got %s", got)
	}
}
