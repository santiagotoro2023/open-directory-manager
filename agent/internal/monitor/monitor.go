// Package monitor measures this machine, and probes what has no agent.
//
// A handful of numbers a minute, read straight from /proc and /sys: how busy
// the processor is, how full the memory and the filesystems are, how much is
// crossing the network, how hot the hottest sensor is. Nothing here installs
// anything or asks a daemon; a machine that can boot can report these.
//
// A machine carrying the monitoring role also runs probes — a ping, a TCP
// connect, an HTTP fetch — against whatever the console lists, and reports
// the answer against the target's name rather than its own.
package monitor

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Sample is one number about one host at one moment. Host is empty for a
// number about this machine; a probe names its target.
type Sample struct {
	Metric string  `json:"metric"`
	Value  float64 `json:"value"`
	Host   string  `json:"host,omitempty"`
}

// Config is what the policy document says about monitoring.
type Config struct {
	Enabled         bool    `json:"enabled"`
	IntervalSeconds int     `json:"interval_seconds"`
	Probes          []Probe `json:"probes"`
}

// Probe is one thing to check from here.
type Probe struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Kind            string `json:"kind"`
	Target          string `json:"target"`
	Port            int    `json:"port"`
	IntervalSeconds int    `json:"interval_seconds"`
}

// State is what one reading needs from the previous: the counters a rate is
// the difference of.
type State struct {
	At      time.Time
	CPUBusy uint64
	CPUAll  uint64
	NetRx   uint64
	NetTx   uint64
}

// Collect reads the machine. root is prefixed to every path, for tests.
func Collect(root string, previous *State) ([]Sample, *State) {
	now := time.Now()
	state := &State{At: now}
	var samples []Sample
	add := func(metric string, value float64) {
		samples = append(samples, Sample{Metric: metric, Value: value})
	}

	if busy, all, ok := cpuCounters(filepath.Join(root, "/proc/stat")); ok {
		state.CPUBusy, state.CPUAll = busy, all
		if previous != nil && all > previous.CPUAll {
			add("cpu_percent", 100*float64(busy-previous.CPUBusy)/float64(all-previous.CPUAll))
		}
	}
	if load, processes, ok := loadavg(filepath.Join(root, "/proc/loadavg")); ok {
		add("load1", load)
		add("processes", processes)
	}
	if mem, swap, ok := memory(filepath.Join(root, "/proc/meminfo")); ok {
		add("mem_percent", mem)
		if swap >= 0 {
			add("swap_percent", swap)
		}
	}
	for _, mount := range mounts(filepath.Join(root, "/proc/mounts")) {
		var fs syscall.Statfs_t
		if err := syscall.Statfs(filepath.Join(root, mount), &fs); err != nil || fs.Blocks == 0 {
			continue
		}
		total := float64(fs.Blocks) * float64(fs.Bsize)
		free := float64(fs.Bavail) * float64(fs.Bsize)
		add("disk_percent:"+mount, 100*(1-free/total))
		add("disk_free_bytes:"+mount, free)
	}
	if rx, tx, ok := netCounters(filepath.Join(root, "/proc/net/dev")); ok {
		state.NetRx, state.NetTx = rx, tx
		if previous != nil && now.After(previous.At) {
			seconds := now.Sub(previous.At).Seconds()
			if rx >= previous.NetRx {
				add("net_rx_bytes_per_s", float64(rx-previous.NetRx)/seconds)
			}
			if tx >= previous.NetTx {
				add("net_tx_bytes_per_s", float64(tx-previous.NetTx)/seconds)
			}
		}
	}
	if temp, ok := hottest(root); ok {
		add("temp_c", temp)
	}
	if up, ok := uptime(filepath.Join(root, "/proc/uptime")); ok {
		add("uptime_seconds", up)
	}
	add("agent_up", 1)
	return samples, state
}

// cpuCounters is the "cpu" line of /proc/stat as busy and total jiffies.
func cpuCounters(path string) (busy, all uint64, ok bool) {
	file, err := os.Open(path)
	if err != nil {
		return 0, 0, false
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 8 || fields[0] != "cpu" {
			continue
		}
		var values []uint64
		for _, field := range fields[1:] {
			value, err := strconv.ParseUint(field, 10, 64)
			if err != nil {
				return 0, 0, false
			}
			values = append(values, value)
		}
		// user nice system idle iowait irq softirq steal ...
		for _, value := range values {
			all += value
		}
		idle := values[3]
		if len(values) > 4 {
			idle += values[4]
		}
		return all - idle, all, true
	}
	return 0, 0, false
}

func loadavg(path string) (load, processes float64, ok bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, false
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 4 {
		return 0, 0, false
	}
	load, err = strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, 0, false
	}
	_, total, found := strings.Cut(fields[3], "/")
	if found {
		processes, _ = strconv.ParseFloat(total, 64)
	}
	return load, processes, true
}

func memory(path string) (memPercent, swapPercent float64, ok bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, false
	}
	values := map[string]float64{}
	for _, line := range strings.Split(string(raw), "\n") {
		key, rest, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		value, err := strconv.ParseFloat(fields[0], 64)
		if err == nil {
			values[key] = value
		}
	}
	total, available := values["MemTotal"], values["MemAvailable"]
	if total == 0 {
		return 0, 0, false
	}
	memPercent = 100 * (1 - available/total)
	swapPercent = -1
	if swapTotal := values["SwapTotal"]; swapTotal > 0 {
		swapPercent = 100 * (1 - values["SwapFree"]/swapTotal)
	}
	return memPercent, swapPercent, true
}

// The filesystems worth a number: real disks, not the kernel's own.
var realFilesystems = map[string]bool{
	"ext4": true, "ext3": true, "ext2": true, "xfs": true, "btrfs": true, "f2fs": true,
	"vfat": true, "exfat": true, "ntfs": true, "ntfs3": true, "zfs": true, "jfs": true,
}

func mounts(path string) []string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || !realFilesystems[fields[2]] {
			continue
		}
		mount := strings.ReplaceAll(fields[1], `\040`, " ")
		if strings.HasPrefix(mount, "/snap/") || strings.HasPrefix(mount, "/var/lib/docker/") ||
			seen[mount] || len(out) >= 24 {
			continue
		}
		seen[mount] = true
		out = append(out, mount)
	}
	return out
}

func netCounters(path string) (rx, tx uint64, ok bool) {
	file, err := os.Open(path)
	if err != nil {
		return 0, 0, false
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		name, rest, found := strings.Cut(scanner.Text(), ":")
		if !found {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "lo" || strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "docker") ||
			strings.HasPrefix(name, "br-") || strings.HasPrefix(name, "virbr") {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 9 {
			continue
		}
		r, err1 := strconv.ParseUint(fields[0], 10, 64)
		t, err2 := strconv.ParseUint(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		rx += r
		tx += t
		ok = true
	}
	return rx, tx, ok
}

// hottest is the highest temperature any sensor reports, in degrees. Both
// the thermal zones and hwmon are read: a laptop has the first, a server
// board the second, a desktop often both.
func hottest(root string) (float64, bool) {
	var best float64
	found := false
	consider := func(path string) {
		raw, err := os.ReadFile(path)
		if err != nil {
			return
		}
		value, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
		if err != nil || value <= 0 || value > 200_000 {
			return
		}
		if value > 1000 {
			value /= 1000 // millidegrees
		}
		if !found || value > best {
			best, found = value, true
		}
	}
	zones, _ := filepath.Glob(filepath.Join(root, "/sys/class/thermal/thermal_zone*/temp"))
	for _, zone := range zones {
		consider(zone)
	}
	sensors, _ := filepath.Glob(filepath.Join(root, "/sys/class/hwmon/hwmon*/temp*_input"))
	for _, sensor := range sensors {
		consider(sensor)
	}
	return best, found
}

func uptime(path string) (float64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(raw))
	if len(fields) == 0 {
		return 0, false
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	return value, err == nil
}

// ------------------------------------------------------------------ probes --

var pingTime = regexp.MustCompile(`time[=<]([0-9.]+) ?ms`)

// RunProbe checks one target and says whether it answered and how fast.
func RunProbe(ctx context.Context, probe Probe) []Sample {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	up, ms := 0.0, 0.0
	switch probe.Kind {
	case "ping":
		out, err := exec.CommandContext(ctx, "ping", "-n", "-c", "1", "-W", "3", probe.Target).CombinedOutput()
		if err == nil {
			up = 1
			if m := pingTime.FindSubmatch(out); m != nil {
				ms, _ = strconv.ParseFloat(string(m[1]), 64)
			}
		}
	case "tcp":
		started := time.Now()
		conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(
			ctx, "tcp", net.JoinHostPort(probe.Target, strconv.Itoa(probe.Port)))
		if err == nil {
			conn.Close()
			up = 1
			ms = float64(time.Since(started).Microseconds()) / 1000
		}
	case "http":
		started := time.Now()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, probe.Target, nil)
		if err == nil {
			// Availability, not trust: a probe asks whether the page answers.
			// Half the pages worth probing on an internal network carry a
			// certificate nothing here can check, and "not answering" for
			// those would hide the outages the probe exists to catch.
			client := &http.Client{
				Timeout:   8 * time.Second,
				Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}, //nolint:gosec
			}
			response, err := client.Do(request)
			if err == nil {
				response.Body.Close()
				if response.StatusCode < 500 {
					up = 1
				}
				ms = float64(time.Since(started).Microseconds()) / 1000
			}
		}
	default:
		return nil
	}
	host := probe.Target
	if probe.Kind == "http" {
		// Named by the URL's host, which is what somebody looks for.
		if request, err := http.NewRequest(http.MethodGet, probe.Target, nil); err == nil {
			host = request.URL.Hostname()
		}
	}
	// One series per kind of check on a target, so a TCP probe and an HTTP
	// probe of the same host do not overwrite each other's answer.
	suffix := ":" + probe.Kind
	if probe.Port > 0 {
		suffix += "-" + strconv.Itoa(probe.Port)
	}
	samples := []Sample{{Metric: "probe_up" + suffix, Value: up, Host: host}}
	if up == 1 {
		samples = append(samples, Sample{Metric: "probe_latency_ms" + suffix, Value: ms, Host: host})
	}
	return samples
}

// SeriesSuffix is the metric suffix a probe reports under; the console
// looks a probe's answer up by it.
func (p Probe) SeriesSuffix() string {
	if p.Port > 0 {
		return ":" + p.Kind + "-" + strconv.Itoa(p.Port)
	}
	return ":" + p.Kind
}

// String is for the agent's own log line.
func (p Probe) String() string {
	if p.Port > 0 {
		return fmt.Sprintf("%s %s:%d", p.Kind, p.Target, p.Port)
	}
	return fmt.Sprintf("%s %s", p.Kind, p.Target)
}
