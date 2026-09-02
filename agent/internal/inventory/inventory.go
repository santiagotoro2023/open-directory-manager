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
	"encoding/json"
	"fmt"
	"net"
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
	User string `json:"user"`
	Line string `json:"line"`
	// "local" or "domain": the same name means different things depending on
	// where the account came from, and an administrator needs to know which.
	Source string `json:"source"`
	Since  string `json:"since"`
}

type Package struct {
	Name    string `json:"name"`
	Version string `json:"version"`
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
	Packages        []Package   `json:"packages"`
	PackageCount    int         `json:"package_count"`
	PendingUpdates  int         `json:"pending_updates"`
	SecurityUpdates int         `json:"security_updates"`
	Updates         []string    `json:"updates"`
	UpdatesChecked  bool        `json:"updates_checked"`
	Events          []Event     `json:"events"`
	Addresses       []string    `json:"addresses"`
	Logs            []LogEntry  `json:"logs"`
	LogCursor       string      `json:"log_cursor"`
	// Printers this machine can see, when it is a print server. Reported with
	// everything else so choosing one in the console is instant, rather than
	// a request that waits for the machine's next check-in.
	PrintDevices []PrintDevice `json:"print_devices,omitempty"`
	// `samba-tool drs showrepl` as this machine sees it, on a controller.
	// Empty everywhere else. See replication.go for why the controller
	// collects this rather than the control plane reading it.
	Replication string `json:"replication,omitempty"`
}

// PrintDevice is one thing CUPS found: a URI it can print to and, when the
// device announced one, what it says it is.
type PrintDevice struct {
	URI         string `json:"uri"`
	Description string `json:"description"`
}

// printDevices asks CUPS what it can print to. Empty on a machine that is not
// a print server, which is the answer there: nothing to choose from.
// PrintDevices is printDevices, exported so an operator can ask for a scan
// rather than waiting for the next check-in. seconds bounds the discovery,
// which is a real network sweep and takes as long as it is given.
func PrintDevices(ctx context.Context, env apply.Env, seconds int) []PrintDevice {
	// Both, because they see different things: CUPS knows about anything it
	// already has a backend for, and avahi knows about anything announcing
	// itself on the network — which is where a driverless printer lives.
	found := printDevices(ctx, env, seconds)
	seen := map[string]bool{}
	for _, device := range found {
		seen[device.URI] = true
	}
	for _, device := range BrowsedPrinters(ctx, env) {
		if !seen[device.URI] {
			found = append(found, device)
		}
	}
	return found
}

func printDevices(ctx context.Context, env apply.Env, seconds int) []PrintDevice {
	if _, err := os.Stat(env.Path("/usr/sbin/cupsd")); err != nil {
		return []PrintDevice{}
	}
	// -l lists local and network devices; the timeout keeps a slow network
	// discovery from holding up the whole check-in.
	if seconds <= 0 {
		seconds = 10
	}
	out, err := env.Run.Run(ctx, "lpinfo", "--timeout", strconv.Itoa(seconds), "-l", "-v")
	if err != nil {
		return []PrintDevice{}
	}
	var devices []PrintDevice
	var current PrintDevice
	for _, line := range strings.Split(out, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "Device:"):
			if current.URI != "" {
				devices = append(devices, current)
			}
			current = PrintDevice{}
		case strings.HasPrefix(trimmed, "uri = "):
			current.URI = strings.TrimPrefix(trimmed, "uri = ")
		case strings.HasPrefix(trimmed, "info = "):
			current.Description = strings.TrimPrefix(trimmed, "info = ")
		}
	}
	if current.URI != "" {
		devices = append(devices, current)
	}
	// A real printer has an address. lpinfo also lists the backends
	// themselves — "ipp", "lpd", "beh" — which are not things to hand
	// somebody as a choice, and neither is printing to a file.
	kept := []PrintDevice{}
	for _, device := range devices {
		if !strings.Contains(device.URI, "://") {
			continue
		}
		if strings.HasPrefix(device.URI, "file:") || device.URI == "cups-brf:/" {
			continue
		}
		kept = append(kept, device)
	}
	return kept
}

// CursorPath is where the last journal position is remembered, so a report
// covers what happened since the previous one rather than the last hour again.
const CursorPath = "/var/lib/odm/log-cursor"

// LogUnits are read at every priority, not only warnings: they are the ones
// that explain why the rest of the machine is unhappy.
var LogUnits = []string{"odm-agent", "sssd", "ssh", "systemd-logind"}

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
		report.Sessions = sessions(ctx, env, report.LocalUsers)
		report.Events = recentEvents(ctx, env)
		report.Packages, report.PackageCount = installedPackages(ctx, env)

		report.PrintDevices = printDevices(ctx, env, 10)
		report.Replication = replicationState(ctx, env)

		previous := strings.TrimSpace(readFile(env, CursorPath))
		report.Logs, report.LogCursor = CollectLogs(ctx, env, previous, LogUnits, 200)
		if report.LogCursor == "" {
			// Nothing new: keep the position we had rather than resetting it.
			report.LogCursor = previous
		}
	}
	report.Addresses = LocalAddresses()
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

func sessions(ctx context.Context, env apply.Env, local []LocalUser) []Session {
	out, err := env.Run.Run(ctx, "who")
	if err != nil {
		return nil
	}
	return ParseWho(out, local)
}

// ParseWho turns `who` output into sessions, marking each as a local or a
// domain account. A name /etc/passwd does not carry came from SSSD, which on a
// joined machine means the directory.
func ParseWho(out string, local []LocalUser) []Session {
	isLocal := map[string]bool{}
	for _, user := range local {
		isLocal[user.Name] = true
	}
	found := []Session{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		source := "domain"
		if isLocal[fields[0]] {
			source = "local"
		}
		found = append(found, Session{
			User:   fields[0],
			Line:   fields[1],
			Source: source,
			Since:  strings.Join(fields[2:], " "),
		})
	}
	return found
}

// installedPackages reports what somebody asked for, not the thousands pulled
// in behind them: "what was put on this machine" is the question an operator
// has, and a dependency list buries it.
func installedPackages(ctx context.Context, env apply.Env) ([]Package, int) {
	manual, err := env.Run.Run(ctx, "apt-mark", "showmanual")
	if err != nil {
		return nil, 0
	}
	wanted := map[string]bool{}
	for _, name := range strings.Fields(manual) {
		wanted[name] = true
	}

	out, err := env.Run.Run(ctx, "dpkg-query", "-W", "-f", "${Package}\t${Version}\t${Status}\n")
	if err != nil {
		return nil, 0
	}
	return ParseInstalled(out, wanted)
}

// ParseInstalled reads dpkg-query output, keeping the packages in `wanted` that
// are actually installed. The second return is how many are installed in total,
// so the console can say how much of the machine the list covers.
func ParseInstalled(out string, wanted map[string]bool) ([]Package, int) {
	packages := []Package{}
	total := 0
	for _, line := range strings.Split(out, "\n") {
		parts := strings.Split(line, "\t")
		// "install ok installed" is the only status that means it is there;
		// "deinstall ok config-files" is a package that has been removed.
		if len(parts) < 3 || !strings.HasPrefix(parts[2], "install ok installed") {
			continue
		}
		total++
		if len(wanted) > 0 && !wanted[parts[0]] {
			continue
		}
		packages = append(packages, Package{Name: parts[0], Version: parts[1]})
	}
	return packages, total
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

// ------------------------------------------------------------------- logs ---
// Warnings and above, plus whatever units policy names. Not a log pipeline:
// enough to answer "why is this machine unhappy" from its page in the console.

type LogEntry struct {
	Unit       string    `json:"unit"`
	Priority   int       `json:"priority"`
	Message    string    `json:"message"`
	OccurredAt time.Time `json:"occurred_at"`
	Cursor     string    `json:"cursor"`
}

// journalctl's own priority numbers. 4 is warning; anything higher is noise
// for this purpose.
const warningPriority = 4

// CollectLogs reads the journal since the last cursor and returns what is
// worth sending, together with the cursor to resume from next time.
func CollectLogs(
	ctx context.Context, env apply.Env, since string, units []string, limit int,
) ([]LogEntry, string) {
	if env.Run == nil {
		return nil, since
	}
	args := []string{"--output=json", "--no-pager", fmt.Sprintf("--lines=%d", limit)}
	if since != "" {
		args = append(args, "--after-cursor="+since)
	} else {
		// A first run would otherwise ship the whole journal.
		args = append(args, "--since=-1h")
	}
	args = append(args, fmt.Sprintf("--priority=%d", warningPriority))

	entries, cursor := runJournal(ctx, env, args, limit)

	// Named units are wanted at every priority, so they are a second read
	// rather than a looser filter on the first.
	for _, unit := range units {
		unitArgs := []string{"--output=json", "--no-pager", "--unit=" + unit,
			fmt.Sprintf("--lines=%d", limit/2)}
		if since != "" {
			unitArgs = append(unitArgs, "--after-cursor="+since)
		} else {
			unitArgs = append(unitArgs, "--since=-1h")
		}
		more, _ := runJournal(ctx, env, unitArgs, limit/2)
		entries = append(entries, more...)
	}

	return dedupe(entries), cursor
}

func runJournal(
	ctx context.Context, env apply.Env, args []string, limit int,
) ([]LogEntry, string) {
	out, err := env.Run.Run(ctx, "journalctl", args...)
	if err != nil {
		return nil, ""
	}
	entries := ParseJournal(out, limit)
	cursor := ""
	if len(entries) > 0 {
		cursor = entries[len(entries)-1].Cursor
	}
	return entries, cursor
}

// ParseJournal reads journalctl --output=json. Exported so its handling of
// the journal's microsecond timestamps and missing fields can be tested.
func ParseJournal(out string, limit int) []LogEntry {
	entries := []LogEntry{}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}
		message := journalString(raw["MESSAGE"])
		if message == "" {
			continue
		}
		// __REALTIME_TIMESTAMP is microseconds since the epoch, as a string.
		micros, err := strconv.ParseInt(journalString(raw["__REALTIME_TIMESTAMP"]), 10, 64)
		if err != nil {
			continue
		}
		priority, err := strconv.Atoi(journalString(raw["PRIORITY"]))
		if err != nil {
			priority = 6
		}
		unit := journalString(raw["_SYSTEMD_UNIT"])
		if unit == "" {
			unit = journalString(raw["SYSLOG_IDENTIFIER"])
		}
		if len(message) > 2000 {
			message = message[:2000]
		}
		entries = append(entries, LogEntry{
			Unit:       strings.TrimSuffix(unit, ".service"),
			Priority:   priority,
			Message:    message,
			OccurredAt: time.UnixMicro(micros).UTC(),
			Cursor:     journalString(raw["__CURSOR"]),
		})
		if len(entries) >= limit {
			break
		}
	}
	return entries
}

// journalString copes with the journal rendering a field as a string, a
// number, or an array of byte values when it is not valid UTF-8.
func journalString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return strconv.FormatInt(int64(typed), 10)
	case []any:
		bytes := make([]byte, 0, len(typed))
		for _, item := range typed {
			if number, ok := item.(float64); ok {
				bytes = append(bytes, byte(int(number)))
			}
		}
		return string(bytes)
	default:
		return ""
	}
}

func dedupe(entries []LogEntry) []LogEntry {
	seen := map[string]bool{}
	unique := make([]LogEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.Cursor == "" || seen[entry.Cursor] {
			continue
		}
		seen[entry.Cursor] = true
		unique = append(unique, entry)
	}
	return unique
}

// LocalAddresses are this machine's own addresses, which is what places it in
// a site. Loopback and link-local are left out: neither says where anything is.
func LocalAddresses() []string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	found := []string{}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err != nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			found = append(found, ip.String())
		}
	}
	return found
}
