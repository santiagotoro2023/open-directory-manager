package inventory

import (
	"os"
	"path/filepath"
	"testing"

	"odm.example.org/agent/internal/apply"
)

func envWith(t *testing.T, files map[string]string) apply.Env {
	t.Helper()
	root := t.TempDir()
	for path, body := range files {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return apply.NewEnv(root)
}

func TestLocalUsersSkipSystemAccounts(t *testing.T) {
	env := envWith(t, map[string]string{
		"etc/passwd": "root:x:0:0:root:/root:/bin/bash\n" +
			"daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n" +
			"ada:x:1000:1000:Ada:/home/ada:/bin/bash\n" +
			"bob:x:1001:1001:Bob:/home/bob:/bin/sh\n" +
			"nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n",
		"etc/group": "sudo:x:27:ada\nusers:x:100:ada,bob\n",
	})

	users := localUsers(env)

	if len(users) != 2 {
		t.Fatalf("expected ada and bob, got %v", users)
	}
	if users[0].Name != "ada" || users[0].UID != 1000 {
		t.Errorf("wrong first user: %+v", users[0])
	}
	// Group membership is what tells an operator who can escalate on the box.
	if len(users[0].Groups) != 2 || users[0].Groups[0] != "sudo" {
		t.Errorf("ada's groups are wrong: %v", users[0].Groups)
	}
	if len(users[1].Groups) != 1 || users[1].Groups[0] != "users" {
		t.Errorf("bob's groups are wrong: %v", users[1].Groups)
	}
}

func TestLastOutputBecomesLogonBootAndShutdownEvents(t *testing.T) {
	out := `ada      pts/0        10.10.0.5        Fri Aug 29 18:04:11 2025   still logged in
reboot   system boot  6.12.0-amd64     Fri Aug 29 17:55:02 2025   still running
root     tty1                          Thu Aug 28 09:12:44 2025 - 10:01:02  (00:48)
shutdown system down  6.12.0-amd64     Thu Aug 28 22:30:00 2025
runlevel (to lvl 5)   6.12.0-amd64     Thu Aug 28 09:00:00 2025

wtmp begins Thu Aug 28 09:00:00 2025
`
	events := ParseLast(out)

	kinds := map[string]int{}
	for _, event := range events {
		kinds[event.Kind]++
	}
	if kinds["logon"] != 2 {
		t.Errorf("expected two logons, got %d from %v", kinds["logon"], events)
	}
	if kinds["boot"] != 1 || kinds["shutdown"] != 1 {
		t.Errorf("boot and shutdown not both recognised: %v", kinds)
	}
	// runlevel records are bookkeeping, not something an operator asked about.
	if len(events) != 4 {
		t.Errorf("expected four events, got %d: %v", len(events), events)
	}
	if events[0].Principal != "ada" || events[0].Detail != "pts/0" {
		t.Errorf("the logon lost its user or terminal: %+v", events[0])
	}
	if events[0].OccurredAt.IsZero() {
		t.Error("the timestamp did not parse; an event with no time cannot be deduplicated")
	}
}

func TestSimulatedUpgradeCountsWhatWouldChange(t *testing.T) {
	out := `NOTE: This is only a simulation!
Inst libc6 [2.36-9] (2.36-9+deb12u3 Debian-Security:12/stable [amd64])
Inst curl [7.88.1-10] (7.88.1-10+deb12u5 Debian:12.5/stable [amd64])
Conf libc6 (2.36-9+deb12u3 Debian-Security:12/stable [amd64])
`
	pending, security, names := ParseSimulation(out)

	if pending != 2 {
		t.Errorf("expected two pending updates, got %d", pending)
	}
	if security != 1 {
		t.Errorf("expected one security update, got %d", security)
	}
	if len(names) != 2 || names[0] != "libc6" {
		t.Errorf("wrong package names: %v", names)
	}
}

func TestNothingToUpgradeReportsZeroRatherThanFailing(t *testing.T) {
	pending, security, names := ParseSimulation("NOTE: This is only a simulation!\n")
	if pending != 0 || security != 0 || len(names) != 0 {
		t.Errorf("expected an empty result, got %d/%d/%v", pending, security, names)
	}
}

func TestBootTimeComesFromUptime(t *testing.T) {
	env := envWith(t, map[string]string{"proc/uptime": "3600.00 7200.00\n"})
	booted, ok := bootTime(env)
	if !ok {
		t.Fatal("uptime was not read")
	}
	if booted.IsZero() {
		t.Error("boot time is zero")
	}
}

func TestAMissingProcUptimeIsNotAnError(t *testing.T) {
	if _, ok := bootTime(envWith(t, nil)); ok {
		t.Error("a machine with no /proc/uptime reported a boot time anyway")
	}
}
