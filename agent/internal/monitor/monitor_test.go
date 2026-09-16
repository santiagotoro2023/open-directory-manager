package monitor

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fakeProc(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(path, body string) {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("/proc/stat", "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\n")
	write("/proc/loadavg", "0.52 0.40 0.30 2/412 12345\n")
	write("/proc/meminfo", "MemTotal:       16000000 kB\nMemFree:         2000000 kB\nMemAvailable:    8000000 kB\nSwapTotal:       4000000 kB\nSwapFree:        3000000 kB\n")
	write("/proc/mounts", "sysfs /sys sysfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n")
	write("/proc/net/dev", "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n")
	write("/proc/uptime", "3600.5 7000.2\n")
	write("/sys/class/thermal/thermal_zone0/temp", "45000\n")
	write("/sys/class/hwmon/hwmon1/temp1_input", "61000\n")
	return root
}

func metric(samples []Sample, name string) (float64, bool) {
	for _, sample := range samples {
		if sample.Metric == name {
			return sample.Value, true
		}
	}
	return 0, false
}

func TestTheMachineIsReadFromProcAndSys(t *testing.T) {
	root := fakeProc(t)
	samples, state := Collect(root, nil)

	for name, wanted := range map[string]float64{
		"load1": 0.52, "processes": 412, "mem_percent": 50, "swap_percent": 25,
		"temp_c": 61, "uptime_seconds": 3600.5, "agent_up": 1,
	} {
		got, ok := metric(samples, name)
		if !ok || got != wanted {
			t.Errorf("%s = %v (present %v), wanted %v", name, got, ok, wanted)
		}
	}
	// A rate needs two readings; the first has none.
	if _, ok := metric(samples, "cpu_percent"); ok {
		t.Error("a processor percentage was made from one reading")
	}
	// The real filesystem in the fake mounts table is measured; tmpfs is not.
	found := false
	for _, sample := range samples {
		if strings.HasPrefix(sample.Metric, "disk_percent:") {
			found = true
		}
		if sample.Metric == "disk_percent:/run" {
			t.Error("tmpfs was measured")
		}
	}
	if !found {
		t.Error("no filesystem was measured")
	}

	// Second reading: 100 more busy jiffies of 200, and 1000 more bytes in
	// over the interval.
	stat := filepath.Join(root, "/proc/stat")
	_ = os.WriteFile(stat, []byte("cpu  200 0 100 900 0 0 0 0 0 0\n"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "/proc/net/dev"), []byte(
		"h\nh\n  eth0: 2000 10 0 0 0 0 0 0 2500 20 0 0 0 0 0 0\n"), 0o644)
	state.At = state.At.Add(-10 * time.Second)
	samples, _ = Collect(root, state)
	cpu, _ := metric(samples, "cpu_percent")
	if cpu < 49 || cpu > 51 {
		t.Errorf("cpu_percent = %v, wanted 50", cpu)
	}
	rx, _ := metric(samples, "net_rx_bytes_per_s")
	if rx < 95 || rx > 105 {
		t.Errorf("net_rx_bytes_per_s = %v, wanted about 100", rx)
	}
}

func TestATcpProbeAnswersAndAClosedPortDoesNot(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip("no loopback")
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	probe := Probe{Kind: "tcp", Target: "127.0.0.1", Port: port}
	samples := RunProbe(context.Background(), probe)
	up, _ := metric(samples, "probe_up"+probe.SeriesSuffix())
	if up != 1 || samples[0].Host != "127.0.0.1" {
		t.Errorf("an open port reads as down: %+v", samples)
	}
	if _, ok := metric(samples, "probe_latency_ms"+probe.SeriesSuffix()); !ok {
		t.Error("no latency for an answered probe")
	}
	listener.Close()
	samples = RunProbe(context.Background(), probe)
	if up, _ := metric(samples, "probe_up"+probe.SeriesSuffix()); up != 0 {
		t.Error("a closed port reads as up")
	}
}

func TestAnHttpProbeIsNamedByItsHost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	samples := RunProbe(context.Background(), Probe{Kind: "http", Target: server.URL + "/health"})
	if up, _ := metric(samples, "probe_up:http"); up != 1 {
		t.Errorf("a 200 reads as down: %+v", samples)
	}
	if samples[0].Host != "127.0.0.1" {
		t.Errorf("named %q, wanted the URL's host", samples[0].Host)
	}
}
