package inventory

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"odm.example.org/agent/internal/apply"
)

// What this machine is, and what its disks think of themselves.
//
// The model and serial are what an operator needs to raise a warranty case;
// the disks are what tells them to raise it before the machine stops. Both
// are read, never changed.

// Hardware is the machine itself.
type Hardware struct {
	Vendor      string `json:"vendor"`
	Model       string `json:"model"`
	Serial      string `json:"serial"`
	Chassis     string `json:"chassis"`
	BiosVersion string `json:"bios_version"`
	BiosDate    string `json:"bios_date"`
	CPU         string `json:"cpu"`
	Cores       int    `json:"cores"`
	MemoryMB    int    `json:"memory_mb"`
}

// Disk is one drive, as SMART reports it.
type Disk struct {
	Device string `json:"device"`
	Model  string `json:"model"`
	Serial string `json:"serial"`
	SizeGB int    `json:"size_gb"`
	// "passed", "failing", or empty where the drive has nothing to say —
	// a virtual disk, or a controller that does not pass SMART through.
	Health         string `json:"health"`
	PowerOnHours   int    `json:"power_on_hours"`
	TemperatureC   int    `json:"temperature_c"`
	Reallocated    int    `json:"reallocated_sectors"`
	PercentageUsed int    `json:"percentage_used"`
}

// chassisNames are the DMI numbers worth telling apart on a fleet.
var chassisNames = map[string]string{
	"3": "desktop", "4": "desktop", "5": "desktop", "6": "desktop", "7": "desktop",
	"8": "laptop", "9": "laptop", "10": "laptop", "14": "laptop", "31": "laptop",
	"17": "server", "23": "server", "28": "server",
	"1": "other", "2": "unknown", "30": "tablet", "32": "detachable",
}

func hardware(env apply.Env) Hardware {
	read := func(name string) string {
		return strings.TrimSpace(readFile(env, "/sys/class/dmi/id/"+name))
	}
	found := Hardware{
		Vendor:      read("sys_vendor"),
		Model:       read("product_name"),
		Serial:      read("product_serial"),
		BiosVersion: read("bios_version"),
		BiosDate:    read("bios_date"),
	}
	if name, ok := chassisNames[read("chassis_type")]; ok {
		found.Chassis = name
	}
	// A serial nobody set is noise on a page about which machine this is.
	for _, unknown := range []string{"None", "To Be Filled By O.E.M.", "Default string", "0"} {
		if strings.EqualFold(found.Serial, unknown) {
			found.Serial = ""
		}
	}

	for _, line := range strings.Split(readFile(env, "/proc/cpuinfo"), "\n") {
		key, value, found_ := strings.Cut(line, ":")
		if !found_ {
			continue
		}
		switch strings.TrimSpace(key) {
		case "model name":
			if found.CPU == "" {
				found.CPU = strings.TrimSpace(value)
			}
		case "processor":
			found.Cores++
		}
	}
	for _, line := range strings.Split(readFile(env, "/proc/meminfo"), "\n") {
		if key, value, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(key) == "MemTotal" {
			fields := strings.Fields(value)
			if len(fields) > 0 {
				if kb, err := strconv.Atoi(fields[0]); err == nil {
					found.MemoryMB = kb / 1024
				}
			}
		}
	}
	return found
}

// disks asks smartctl. Without it there is nothing to report and nothing to
// install: a machine that cannot answer says so by saying nothing.
func disks(ctx context.Context, env apply.Env) []Disk {
	if env.Run == nil {
		return nil
	}
	out, err := env.Run.Run(ctx, "smartctl", "--scan", "--json")
	if err != nil {
		return nil
	}
	var scan struct {
		Devices []struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"devices"`
	}
	if json.Unmarshal([]byte(out), &scan) != nil {
		return nil
	}

	found := make([]Disk, 0, len(scan.Devices))
	for _, device := range scan.Devices {
		if len(found) >= 16 {
			break
		}
		detail, err := env.Run.Run(ctx, "smartctl", "-H", "-A", "-i", "--json", device.Name)
		// A failing drive makes smartctl exit non-zero and still print its
		// answer, which is exactly the answer worth having.
		if err != nil && strings.TrimSpace(detail) == "" {
			continue
		}
		if disk, ok := parseSmart(detail); ok {
			disk.Device = device.Name
			found = append(found, disk)
		}
	}
	return found
}

// ParseSmart reads smartctl --json. Exported so what it makes of a real
// drive's output can be tested without one.
func ParseSmart(out string) (Disk, bool) { return parseSmart(out) }

func parseSmart(out string) (Disk, bool) {
	var report struct {
		ModelName    string `json:"model_name"`
		SerialNumber string `json:"serial_number"`
		UserCapacity struct {
			Bytes int64 `json:"bytes"`
		} `json:"user_capacity"`
		SmartStatus struct {
			Passed *bool `json:"passed"`
		} `json:"smart_status"`
		PowerOnTime struct {
			Hours int `json:"hours"`
		} `json:"power_on_time"`
		Temperature struct {
			Current int `json:"current"`
		} `json:"temperature"`
		NvmeHealth struct {
			PercentageUsed int `json:"percentage_used"`
		} `json:"nvme_smart_health_information_log"`
		AtaAttributes struct {
			Table []struct {
				Name string `json:"name"`
				Raw  struct {
					Value int `json:"value"`
				} `json:"raw"`
			} `json:"table"`
		} `json:"ata_smart_attributes"`
	}
	if json.Unmarshal([]byte(out), &report) != nil {
		return Disk{}, false
	}
	disk := Disk{
		Model:          report.ModelName,
		Serial:         report.SerialNumber,
		SizeGB:         int(report.UserCapacity.Bytes / 1_000_000_000),
		PowerOnHours:   report.PowerOnTime.Hours,
		TemperatureC:   report.Temperature.Current,
		PercentageUsed: report.NvmeHealth.PercentageUsed,
	}
	if report.SmartStatus.Passed != nil {
		disk.Health = "failing"
		if *report.SmartStatus.Passed {
			disk.Health = "passed"
		}
	}
	for _, attribute := range report.AtaAttributes.Table {
		if strings.EqualFold(attribute.Name, "Reallocated_Sector_Ct") {
			disk.Reallocated = attribute.Raw.Value
		}
	}
	return disk, true
}
