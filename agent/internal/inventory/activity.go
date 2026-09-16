package inventory

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"odm.example.org/agent/internal/apply"
)

// Activity is what a person did on this machine, read from its journal and
// turned into one event each: a sign-in, a sudo command, a switch to root, a
// second factor approved or refused, a password changed, a local account
// added, a USB device plugged in. The journal already holds all of it — every
// one of these programs says what it did — but as prose, per program, mixed
// with everything else, on the machine it happened on. Here it becomes the
// same few fields for every kind, shipped to the control plane, where the
// question is "what did this person do, on which machines, this week" and
// the answer has to come from one place.
//
// Read since the last position, the same way the ordinary log shipping
// works, so nothing is lost across reports and nothing is sent twice.

// ActivityCursorPath remembers where the last activity read stopped.
const ActivityCursorPath = "/var/lib/odm/activity-cursor"

// UsbCursorPath is the same for the kernel's own log, read separately: it is
// a different, far noisier stream, and its position is its own.
const UsbCursorPath = "/var/lib/odm/usb-cursor"

// activitySources are the programs whose journal lines are read. Matching on
// SYSLOG_IDENTIFIER, which is what PAM lines carry too: pam_unix(sudo:auth)
// is logged by sudo, under sudo's name.
var activitySources = []string{
	"sudo", "su", "sshd", "sshd-session", "login",
	"gdm-password", "gdm-session-worker", "lightdm", "sddm", "xrdp-sesman",
	"passwd", "chpasswd", "useradd", "userdel", "usermod", "gpasswd",
	"odm-agent",
}

// Services whose PAM sessions are not a person signing in: sudo and su are
// recorded from their own lines, and the rest are the system talking to
// itself.
var notASignIn = map[string]bool{
	"sudo": true, "sudo-i": true, "su": true, "su-l": true, "runuser": true,
	"runuser-l": true, "cron": true, "systemd-user": true, "polkit-1": true,
	"gdm-launch-environment": true, "gdm-autologin": false,
}

var (
	// "   alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/apt update"
	// "alice : 3 incorrect password attempts ; TTY=pts/0 ; PWD=/ ; USER=root ; COMMAND=/bin/ls"
	// "alice : user NOT in sudoers ; TTY=pts/0 ; PWD=/ ; USER=root ; COMMAND=/bin/ls"
	sudoLine = regexp.MustCompile(
		`^\s*(\S+) : (?:(.+?) ; )?TTY=(\S+) ; PWD=(.*?) ; USER=(\S+) ;(?: ENV=.*? ;)? COMMAND=(.*)$`)
	// "pam_sss(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=10.0.0.5 user=alice"
	pamFailure = regexp.MustCompile(
		`^pam_sss\(([\w.-]+):auth\): authentication failure;.*?\brhost=(\S*).*?\buser=(\S+)`)
	// "pam_unix(gdm-password:session): session opened for user alice(uid=1000) by (uid=0)"
	pamSession = regexp.MustCompile(
		`^pam_unix\(([\w.-]+):session\): session (opened|closed) for user ([^(\s]+)`)
	// "Accepted publickey for alice from 10.0.0.5 port 50022 ssh2: ED25519 SHA256:..."
	sshAccepted = regexp.MustCompile(`^Accepted (\S+) for (\S+) from (\S+) port \d+`)
	// "Failed password for alice from 10.0.0.5 port 50022 ssh2"
	// "Failed password for invalid user bob from 10.0.0.5 port 50022 ssh2"
	sshFailed = regexp.MustCompile(`^Failed (\S+) for (?:invalid user )?(\S+) from (\S+) port \d+`)
	// "Invalid user bob from 10.0.0.5 port 50022"
	sshInvalid = regexp.MustCompile(`^Invalid user (\S+) from (\S+) port \d+`)
	// "(to root) alice on pts/1"    "FAILED SU (to root) alice on pts/1"
	suLine = regexp.MustCompile(`^(FAILED SU )?\(to (\S+)\) (\S+) on (\S+)`)
	// "pam_unix(passwd:chauthtok): password changed for alice"
	passwordChanged = regexp.MustCompile(`password changed for (\S+)`)
	// "new user: name=bob, UID=1001, GID=1001, home=/home/bob, shell=/bin/bash, from=/dev/pts/0"
	userAdded = regexp.MustCompile(`^new user: name=([^,]+), UID=(\d+)`)
	// "delete user 'bob'"
	userRemoved = regexp.MustCompile(`^delete user '([^']+)'`)
	// "add 'bob' to group 'sudo'"    "remove 'bob' from group 'sudo'"
	groupChanged = regexp.MustCompile(`^(add|remove) '([^']+)' (?:to|from) group '([^']+)'`)
	// What odm-agent itself logs when a second factor is asked for.
	secondFactor = regexp.MustCompile(`^second factor: (approved|denied|no answer|enrolled|removed) for (\S+) \(([\w-]+)\)`)
	// "usb 1-3: New USB device found, idVendor=0781, idProduct=5591, bcdDevice= 1.00"
	usbFound = regexp.MustCompile(`^usb ([\d.-]+): New USB device found, idVendor=([0-9a-f]+), idProduct=([0-9a-f]+)`)
	// "usb 1-3: Product: Ultra"
	usbProduct = regexp.MustCompile(`^usb ([\d.-]+): Product: (.+)$`)
	// "usb 1-3: USB disconnect, device number 5"
	usbGone = regexp.MustCompile(`^usb ([\d.-]+): USB disconnect`)
)

// CollectActivity reads the journal since the given positions and returns
// what happened, with the positions to resume from. Bounded: past the limit
// the rest waits for the next report, and the cursor stops where the report
// does, so nothing is skipped.
func CollectActivity(
	ctx context.Context, env apply.Env, since, usbSince string, limit int,
) (events []Event, cursor, usbCursor string) {
	if env.Run == nil {
		return nil, since, usbSince
	}
	args := []string{"--output=json", "--no-pager"}
	if since != "" {
		args = append(args, "--after-cursor="+since)
	} else {
		args = append(args, "--since=-1h")
	}
	for _, source := range activitySources {
		args = append(args, "SYSLOG_IDENTIFIER="+source)
	}
	cursor = since
	if out, err := env.Run.Run(ctx, "journalctl", args...); err == nil {
		var found []Event
		found, cursor = ParseActivity(out, limit)
		events = append(events, found...)
		if cursor == "" {
			cursor = since
		}
	}

	kernel := []string{"--output=json", "--no-pager", "--dmesg",
		"--grep=New USB device found|USB disconnect|: Product: "}
	if usbSince != "" {
		kernel = append(kernel, "--after-cursor="+usbSince)
	} else {
		kernel = append(kernel, "--since=-1h")
	}
	usbCursor = usbSince
	if out, err := env.Run.Run(ctx, "journalctl", kernel...); err == nil {
		var found []Event
		found, usbCursor = ParseActivity(out, limit)
		events = append(events, found...)
		if usbCursor == "" {
			usbCursor = usbSince
		}
	}
	return events, cursor, usbCursor
}

// ParseActivity turns journalctl --output=json lines into events. Exported
// so every message shape above is pinned by a test rather than by a machine.
// The cursor returned is that of the last line consumed, whether or not it
// became an event.
func ParseActivity(out string, limit int) ([]Event, string) {
	events := []Event{}
	cursor := ""
	// A USB device announces itself over several lines; the product name
	// arrives after the vendor and product ids. Joined by port so the event
	// says what was plugged in, not only that something was.
	usbByPort := map[string]int{}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}
		message := journalString(raw["MESSAGE"])
		micros, err := strconv.ParseInt(journalString(raw["__REALTIME_TIMESTAMP"]), 10, 64)
		if err != nil {
			continue
		}
		cursor = journalString(raw["__CURSOR"])
		when := time.UnixMicro(micros).UTC()
		identifier := journalString(raw["SYSLOG_IDENTIFIER"])
		if journalString(raw["_TRANSPORT"]) == "kernel" {
			identifier = "kernel"
		}

		if m := usbProduct.FindStringSubmatch(message); m != nil && identifier == "kernel" {
			if index, ok := usbByPort[m[1]]; ok {
				events[index].Detail = strings.TrimSpace(m[2]) + " (" + events[index].Detail + ")"
			}
			continue
		}
		event, ok := classify(identifier, message, when)
		if !ok {
			continue
		}
		if event.Kind == "usb-connected" {
			usbByPort[event.Source] = len(events)
		}
		events = append(events, event)
		if len(events) >= limit {
			break
		}
	}
	return events, cursor
}

// classify is one journal line as an event, or nothing.
func classify(identifier, message string, when time.Time) (Event, bool) {
	event := Event{OccurredAt: when}
	switch identifier {
	case "sudo":
		if m := sudoLine.FindStringSubmatch(message); m != nil {
			event.Principal, event.Source, event.Detail = shortName(m[1]), m[3], m[6]
			event.Service = "sudo"
			if m[5] != "root" && m[5] != "" {
				event.Detail = "as " + m[5] + ": " + m[6]
			}
			if m[2] == "" {
				event.Kind = "sudo"
			} else {
				event.Kind = "sudo-denied"
				event.Detail = m[2] + ": " + event.Detail
			}
			return event, true
		}
	case "su":
		if m := suLine.FindStringSubmatch(message); m != nil {
			event.Principal, event.Source, event.Service = shortName(m[3]), m[4], "su"
			event.Detail = "to " + m[2]
			if m[1] == "" {
				event.Kind = "su"
			} else {
				event.Kind = "su-denied"
			}
			return event, true
		}
	case "sshd", "sshd-session":
		if m := sshAccepted.FindStringSubmatch(message); m != nil {
			event.Kind, event.Principal, event.Source, event.Service = "sign-in", shortName(m[2]), m[3], "ssh"
			event.Detail = "by " + m[1]
			return event, true
		}
		if m := sshFailed.FindStringSubmatch(message); m != nil {
			event.Kind, event.Principal, event.Source, event.Service = "sign-in-failed", shortName(m[2]), m[3], "ssh"
			event.Detail = "wrong " + m[1]
			return event, true
		}
		if m := sshInvalid.FindStringSubmatch(message); m != nil {
			event.Kind, event.Principal, event.Source, event.Service = "sign-in-failed", shortName(m[1]), m[2], "ssh"
			event.Detail = "no such account"
			return event, true
		}
	case "passwd", "chpasswd", "usermod":
		if m := passwordChanged.FindStringSubmatch(message); m != nil {
			event.Kind, event.Principal, event.Service = "password-changed", shortName(m[1]), identifier
			return event, true
		}
	case "useradd":
		if m := userAdded.FindStringSubmatch(message); m != nil {
			event.Kind, event.Principal, event.Service = "local-user-added", m[1], "useradd"
			event.Detail = "uid " + m[2]
			return event, true
		}
	case "userdel":
		if m := userRemoved.FindStringSubmatch(message); m != nil {
			event.Kind, event.Principal, event.Service = "local-user-removed", m[1], "userdel"
			return event, true
		}
	case "odm-agent":
		if m := secondFactor.FindStringSubmatch(message); m != nil {
			event.Principal, event.Service = shortName(m[2]), m[3]
			switch m[1] {
			case "approved":
				event.Kind = "second-factor-approved"
			case "denied":
				event.Kind = "second-factor-denied"
			case "no answer":
				event.Kind = "second-factor-timeout"
			case "enrolled":
				event.Kind = "second-factor-enrolled"
			case "removed":
				event.Kind = "second-factor-removed"
			}
			return event, true
		}
	case "kernel":
		if m := usbFound.FindStringSubmatch(message); m != nil {
			event.Kind, event.Source, event.Detail = "usb-connected", m[1], m[2]+":"+m[3]
			return event, true
		}
		if m := usbGone.FindStringSubmatch(message); m != nil {
			event.Kind, event.Source = "usb-disconnected", m[1]
			return event, true
		}
	}
	// gpasswd and usermod both change group membership.
	if identifier == "gpasswd" || identifier == "usermod" {
		if m := groupChanged.FindStringSubmatch(message); m != nil {
			event.Kind, event.Principal, event.Service = "group-changed", m[2], identifier
			if m[1] == "add" {
				event.Detail = "added to " + m[3]
			} else {
				event.Detail = "removed from " + m[3]
			}
			return event, true
		}
	}
	// PAM lines carry the service in their own name, whichever program logged
	// them. A failure from pam_sss is a domain account refused; pam_unix's
	// "authentication failure" is logged for every domain account on every
	// sign-in, successful or not, because the local password file has no
	// entry for it — which is why pam_unix is not read for failures.
	if m := pamFailure.FindStringSubmatch(message); m != nil {
		event.Kind, event.Principal, event.Source = "sign-in-failed", shortName(m[3]), m[2]
		event.Service = serviceName(m[1])
		return event, true
	}
	if m := pamSession.FindStringSubmatch(message); m != nil {
		service := m[1]
		if notASignIn[service] || service == "sshd" && m[2] == "opened" {
			// sshd's own "Accepted" line is the sign-in, with the address.
			return event, false
		}
		user := shortName(m[3])
		if user == "gdm" || user == "lightdm" || user == "sddm" {
			return event, false
		}
		event.Principal, event.Service = user, serviceName(service)
		if m[2] == "opened" {
			event.Kind = "sign-in"
		} else {
			event.Kind = "sign-out"
		}
		return event, true
	}
	return event, false
}

// serviceName is the PAM service as the console names it.
func serviceName(service string) string {
	switch service {
	case "sshd":
		return "ssh"
	case "gdm-password", "gdm-session-worker", "lightdm", "sddm", "login":
		return "login"
	case "xrdp-sesman":
		return "remote-desktop"
	}
	return service
}

// shortName is the account without a realm or domain prefix, lower case,
// which is how the directory names it and how the console looks it up.
func shortName(name string) string {
	name = strings.TrimSpace(name)
	if _, rest, found := strings.Cut(name, `\`); found {
		name = rest
	}
	name, _, _ = strings.Cut(name, "@")
	return strings.ToLower(name)
}
