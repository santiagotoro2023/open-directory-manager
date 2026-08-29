// Package inventory reports what the directory cannot know about a machine:
// who is logged into it, when it booted, which local accounts it carries and
// what updates are waiting.
//
// Everything here is read from the machine's own records — /etc/passwd, wtmp,
// /proc/uptime, apt's own simulation — rather than inferred from check-ins, so
// a machine that was switched off is distinguishable from one whose agent was
// stopped.
package inventory

import (
	"bufio"
	"context"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"odm.example.org/agent/internal/apply"
)

// Accounts below this are the distribution's own.
const firstHumanUID = 1000

type LocalUser struct {
	Name   string   `json:"name"`
	UID    int      `json:"uid"`
	Shell  string   `json:"shell"`
	Home   string   `json:"home"`
	Groups []string `json:"groups"`
}

type Session struct {
	User  string `json:"user"`
	Line  string `json:"line"`
	Since string `json:"since"`
}

type Event struct {
	Kind       string    `json:"kind"`
	Principal  string    `json:"principal"`
	OccurredAt time.Time `json:"occurred_at"`
	Detail     string    `json:"detail,omitempty"`
}

type Report struct {
	OperatingSystem string      `json:"operating_system"`
	Kernel          string      `json:"kernel"`
	BootedAt        *time.Time  `json:"booted_at,omitempty"`
	LocalUsers      []LocalUser `json:"local_users"`
	Sessions        []Session   `json:"sessions"`
	PendingUpdates  int         `json:"pending_updates"`
	SecurityUpdates int         `json:"security_updates"`
	Updates         []string    `json:"updates"`
	UpdatesChecked  bool        `json:"updates_checked"`
	Events          []Event     `json:"events"`
}

// Collect gathers the machine's current state. Anything that cannot be read is
// left empty rather than failing the report: a partial inventory is worth more
// than none, and the console shows what is missing.
func Collect(ctx context.Context, env apply.Env) Report {
	report := Report{
		OperatingSystem: osRelease(env),
		Kernel:          strings.TrimSpace(readFile(env, "/proc/sys/kernel/osrelease")),
		LocalUsers:      localUsers(env),
	}
	if booted, ok := bootTime(env); ok {
		report.BootedAt = &booted
	}
	if env.Run != nil {
		report.Sessions = sessions(ctx, env)
		report.Events = recentEvents(ctx, env)
	}
	pending, security, names := PendingUpdates(ctx, env)
	report.PendingUpdates, report.SecurityUpdates, report.Updates = pending, security, names
	return report
}

func readFile(env apply.Env, path string) string {
	raw, err := os.ReadFile(env.Path(path))
	if err != nil {
		return ""
	}
	return string(raw)
}

func osRelease(env apply.Env) string {
	var id, version string
	for _, line := range strings.Split(readFile(env, "/etc/os-release"), "\n") {
		key, value, found := strings.Cut(strings.TrimSpace(line), "=")
		if !found {
			continue
		}
		value = strings.Trim(value, `"`)
		switch key {
		case "ID":
			id = value
		case "VERSION_ID":
			version = value
		}
	}
	if id == "" {
		return ""
	}
	if version == "" {
		return id
	}
	return id + "-" + version
}

func bootTime(env apply.Env) (time.Time, bool) {
	fields := strings.Fields(readFile(env, "/proc/uptime"))
	if len(fields) == 0 {
		return time.Time{}, false
	}
	seconds, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.Now().Add(-time.Duration(seconds) * time.Second).UTC(), true
}

func localUsers(env apply.Env) []LocalUser {
	membership := groupMembership(env)
	users := []LocalUser{}
	scanner := bufio.NewScanner(strings.NewReader(readFile(env, "/etc/passwd")))
	for scanner.Scan() {
		parts := strings.Split(scanner.Text(), ":")
		if len(parts) < 7 {
			continue
		}
		uid, err := strconv.Atoi(parts[2])
		// Only real people. The distribution's service accounts are noise on a
		// page about who can use the machine.
		if err != nil || uid < firstHumanUID || uid >= 65534 {
			continue
		}
		users = append(users, LocalUser{
			Name:   parts[0],
			UID:    uid,
			Home:   parts[5],
			Shell:  parts[6],
			Groups: membership[parts[0]],
		})
	}
	return users
}

func groupMembership(env apply.Env) map[string][]string {
	membership := map[string][]string{}
	scanner := bufio.NewScanner(strings.NewReader(readFile(env, "/etc/group")))
	for scanner.Scan() {
		parts := strings.Split(scanner.Text(), ":")
		if len(parts) < 4 || parts[3] == "" {
			continue
		}
		for _, member := range strings.Split(parts[3], ",") {
			member = strings.TrimSpace(member)
			if member != "" {
				membership[member] = append(membership[member], parts[0])
			}
		}
	}
	return membership
}

func sessions(ctx context.Context, env apply.Env) []Session {
	out, err := env.Run.Run(ctx, "who")
	if err != nil {
		return nil
	}
	found := []Session{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		found = append(found, Session{
			User:  fields[0],
			Line:  fields[1],
			Since: strings.Join(fields[2:], " "),
		})
	}
	return found
}

// `last -F` prints a full timestamp per record, which is what makes an event
// identifiable rather than "Tue 14:05". The number of fields before it varies
// — "reboot system boot 6.12.0-amd64" against "ada pts/0 10.10.0.5" — so the
// timestamp is found rather than counted to.
var lastTimestamp = regexp.MustCompile(`\w{3} \w{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4}`)

const lastLayout = "Mon Jan _2 15:04:05 2006"

func recentEvents(ctx context.Context, env apply.Env) []Event {
	out, err := env.Run.Run(ctx, "last", "-F", "-n", "100")
	if err != nil {
		return nil
	}
	return ParseLast(out)
}

// ParseLast turns `last -F` output into events. Exported so its handling of
// reboots, shutdowns and ordinary logins can be tested without a wtmp.
func ParseLast(out string) []Event {
	events := []Event{}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" || strings.HasPrefix(line, "wtmp begins") {
			continue
		}
		stamp := lastTimestamp.FindString(line)
		if stamp == "" {
			continue
		}
		when, err := time.ParseInLocation(lastLayout, stamp, time.Local)
		if err != nil {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		user, terminal := fields[0], fields[1]

		switch {
		case user == "reboot":
			events = append(events, Event{Kind: "boot", OccurredAt: when.UTC()})
		case user == "shutdown":
			events = append(events, Event{Kind: "shutdown", OccurredAt: when.UTC()})
		case user == "runlevel":
			continue
		default:
			events = append(events, Event{
				Kind:       "logon",
				Principal:  user,
				OccurredAt: when.UTC(),
				Detail:     terminal,
			})
		}
	}
	return events
}

// PendingUpdates asks apt what an upgrade would do, without doing it. Returns
// the total, how many of those come from a security source, and their names.
func PendingUpdates(ctx context.Context, env apply.Env) (int, int, []string) {
	if env.Run == nil {
		return 0, 0, nil
	}
	out, err := env.Run.Run(ctx, "apt-get", "--simulate", "--quiet", "upgrade")
	if err != nil {
		return 0, 0, nil
	}
	return ParseSimulation(out)
}

// ParseSimulation reads `apt-get --simulate upgrade` output. Exported for the
// same reason: the counts drive what an operator sees, so they are tested.
func ParseSimulation(out string) (int, int, []string) {
	names := []string{}
	security := 0
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		// "Inst linux-image-amd64 [6.1.0] (6.1.1 Debian-Security:12/stable [amd64])"
		if len(fields) < 2 || fields[0] != "Inst" {
			continue
		}
		names = append(names, fields[1])
		if strings.Contains(strings.ToLower(line), "security") {
			security++
		}
	}
	return len(names), security, names
}
