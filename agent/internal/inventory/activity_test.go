package inventory

import (
	"encoding/json"
	"strings"
	"testing"
)

// journal builds journalctl --output=json lines, one per message, a second
// apart, so a test reads like the journal it stands in for.
func journal(t *testing.T, entries ...[2]string) string {
	t.Helper()
	var lines []string
	for index, entry := range entries {
		raw := map[string]string{
			"SYSLOG_IDENTIFIER":    entry[0],
			"MESSAGE":              entry[1],
			"__REALTIME_TIMESTAMP": "1700000000000000",
			"__CURSOR":             "s=cursor" + string(rune('a'+index)),
		}
		if entry[0] == "kernel" {
			raw["_TRANSPORT"] = "kernel"
		}
		line, err := json.Marshal(raw)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, string(line))
	}
	return strings.Join(lines, "\n") + "\n"
}

func TestEverySortOfActivityIsReadFromTheJournal(t *testing.T) {
	out := journal(t,
		[2]string{"sudo", "   alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/apt update"},
		[2]string{"sudo", "alice : 3 incorrect password attempts ; TTY=pts/0 ; PWD=/ ; USER=root ; COMMAND=/bin/ls"},
		[2]string{"sudo", "bob : user NOT in sudoers ; TTY=pts/1 ; PWD=/home/bob ; USER=root ; COMMAND=/bin/cat /etc/shadow"},
		[2]string{"sudo", "pam_unix(sudo:session): session opened for user root(uid=0) by alice(uid=1000)"},
		[2]string{"sudo", "pam_unix(sudo:auth): authentication failure; logname= uid=0 euid=0 tty=/dev/pts/0 ruser=alice rhost=  user=alice"},
		[2]string{"su", "(to root) alice on pts/1"},
		[2]string{"su", "FAILED SU (to root) bob on pts/2"},
		[2]string{"sshd", "Accepted publickey for alice from 10.0.0.5 port 50022 ssh2: ED25519 SHA256:abc"},
		[2]string{"sshd", "pam_unix(sshd:session): session opened for user alice(uid=1000) by (uid=0)"},
		[2]string{"sshd", "Failed password for invalid user mallory from 10.0.0.9 port 4444 ssh2"},
		[2]string{"sshd", "Invalid user mallory from 10.0.0.9 port 4444"},
		[2]string{"sshd", "pam_unix(sshd:session): session closed for user alice"},
		[2]string{"gdm-password", "pam_unix(gdm-password:auth): authentication failure; logname= uid=0 euid=0 tty=/dev/tty1 ruser= rhost=  user=alice"},
		[2]string{"gdm-password", "pam_sss(gdm-password:auth): authentication failure; logname= uid=0 euid=0 tty=/dev/tty1 ruser= rhost= user=alice"},
		[2]string{"gdm-password", "pam_unix(gdm-password:session): session opened for user alice(uid=1000) by (uid=0)"},
		[2]string{"gdm-launch-environment", "pam_unix(gdm-launch-environment:session): session opened for user gdm(uid=110) by (uid=0)"},
		[2]string{"cron", "pam_unix(cron:session): session opened for user root(uid=0) by (uid=0)"},
		[2]string{"passwd", "pam_unix(passwd:chauthtok): password changed for bob"},
		[2]string{"useradd", "new user: name=carol, UID=1002, GID=1002, home=/home/carol, shell=/bin/bash, from=/dev/pts/0"},
		[2]string{"gpasswd", "add 'carol' to group 'sudo'"},
		[2]string{"usermod", "remove 'carol' from group 'sudo'"},
		[2]string{"userdel", "delete user 'carol'"},
		[2]string{"odm-agent", "second factor: approved for CORP\\Alice (sudo)"},
		[2]string{"odm-agent", "second factor: denied for alice (login)"},
		[2]string{"odm-agent", "second factor: enrolled for alice (phone)"},
		[2]string{"kernel", "usb 1-3: New USB device found, idVendor=0781, idProduct=5591, bcdDevice= 1.00"},
		[2]string{"kernel", "usb 1-3: New USB device strings: Mfr=1, Product=2, SerialNumber=3"},
		[2]string{"kernel", "usb 1-3: Product: Ultra"},
		[2]string{"kernel", "usb 1-3: USB disconnect, device number 5"},
	)
	events, cursor := ParseActivity(out, 500)

	got := map[string]Event{}
	for _, event := range events {
		got[event.Kind+"/"+event.Principal+"/"+event.Source+"/"+event.Detail] = event
	}
	wanted := []struct {
		key             string
		service, detail string
	}{
		{"sudo/alice/pts/0", "sudo", "/usr/bin/apt update"},
		{"sudo-denied/alice/pts/0", "sudo", "3 incorrect password attempts: /bin/ls"},
		{"sudo-denied/bob/pts/1", "sudo", "user NOT in sudoers: /bin/cat /etc/shadow"},
		{"su/alice/pts/1", "su", "to root"},
		{"su-denied/bob/pts/2", "su", "to root"},
		{"sign-in/alice/10.0.0.5", "ssh", "by publickey"},
		{"sign-in-failed/mallory/10.0.0.9", "ssh", "wrong password"},
		{"sign-in-failed/mallory/10.0.0.9", "ssh", "no such account"},
		{"sign-out/alice/", "ssh", ""},
		{"sign-in-failed/alice/", "login", ""},
		{"sign-in/alice/", "login", ""},
		{"password-changed/bob/", "passwd", ""},
		{"local-user-added/carol/", "useradd", "uid 1002"},
		{"group-changed/carol/", "gpasswd", "added to sudo"},
		{"group-changed/carol/", "usermod", "removed from sudo"},
		{"local-user-removed/carol/", "userdel", ""},
		{"second-factor-approved/alice/", "sudo", ""},
		{"second-factor-denied/alice/", "login", ""},
		{"second-factor-enrolled/alice/", "phone", ""},
		{"usb-connected//1-3", "", "Ultra (0781:5591)"},
		{"usb-disconnected//1-3", "", ""},
	}
	for _, want := range wanted {
		event, ok := got[want.key+"/"+want.detail]
		if !ok {
			t.Errorf("no %s (%s) event; got %v", want.key, want.detail, keys(got))
			continue
		}
		if event.Service != want.service {
			t.Errorf("%s: service %q, wanted %q", want.key, event.Service, want.service)
		}
	}

	// What is deliberately not an event: pam_unix fails for every domain
	// account on every sign-in, and only pam_sss says whether the domain
	// refused it; the system opening sessions for itself; an ssh sign-in
	// that sshd and PAM both reported.
	failures := 0
	for _, event := range events {
		if event.Kind == "sign-in-failed" && event.Principal == "alice" && event.Service == "login" {
			failures++
		}
		if event.Kind == "sign-in" && (event.Principal == "gdm" || event.Principal == "root") {
			t.Errorf("the system signing in to itself is not a person: %+v", event)
		}
		if event.Kind == "sign-in" && event.Service == "ssh" && event.Detail == "" {
			t.Errorf("an ssh sign-in was counted twice: %+v", event)
		}
	}
	if failures != 1 {
		t.Errorf("pam_unix's routine failure for a domain account was counted: %d failures", failures)
	}
	if cursor == "" {
		t.Error("no cursor to resume from")
	}
}

func keys(m map[string]Event) []string {
	var out []string
	for key := range m {
		out = append(out, key)
	}
	return out
}

func TestTheLimitStopsTheCursorWhereTheReportStops(t *testing.T) {
	out := journal(t,
		[2]string{"su", "(to root) alice on pts/1"},
		[2]string{"su", "(to root) bob on pts/2"},
		[2]string{"su", "(to root) carol on pts/3"},
	)
	events, cursor := ParseActivity(out, 2)
	if len(events) != 2 {
		t.Fatalf("got %d events for a limit of 2", len(events))
	}
	// The next report resumes after the second line, so the third is not
	// lost — it would be if the cursor were the last line read.
	if cursor != "s=cursorb" {
		t.Errorf("cursor %q does not stop where the report did", cursor)
	}
}

func TestAnUnreadableLineIsSkippedNotFatal(t *testing.T) {
	out := "not json at all\n" + journal(t, [2]string{"su", "(to root) alice on pts/1"})
	events, _ := ParseActivity(out, 10)
	if len(events) != 1 {
		t.Errorf("got %d events", len(events))
	}
}
