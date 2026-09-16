package apply

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Firmware updates, through fwupd and the Linux Vendor Firmware Service.
//
// fwupd is installed the first time a policy asks, its metadata refreshed at
// every apply (bounded: fwupd itself refuses to refresh more than hourly),
// and what it finds is written to a file the inventory reads back, so the
// machine's page shows "BIOS 1.14 → 1.16" without a request to the machine.
// In install mode the updates are applied; a reboot is only taken when the
// policy says so, and then through the ordinary restart path.

const firmwarePendingPath = "/var/lib/odm/firmware-updates.json"

// FirmwareUpdate is one thing fwupd could update, as the inventory reports
// it.
type FirmwareUpdate struct {
	Device  string `json:"device"`
	Current string `json:"current"`
	Version string `json:"version"`
	Summary string `json:"summary,omitempty"`
}

func applyFirmwareUpdates(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.FirmwareUpdates == nil || !s.FirmwareUpdates.Enabled {
		// Nothing pending to report once the setting is gone; the prune
		// removes the file.
		return nil
	}
	f := *s.FirmwareUpdates
	if env.Run == nil {
		return []policy.Result{policy.Skip("firmware_updates", "no command runner")}
	}
	if _, err := exec.LookPath("fwupdmgr"); err != nil {
		if out, err := Unsandboxed(ctx, env, "apt-get", "install", "-y", "--no-install-recommends", "fwupd"); err != nil {
			return []policy.Result{policy.Fail("firmware_updates",
				fmt.Errorf("fwupd is not installed and could not be installed: %w: %s", err, strings.TrimSpace(out)))}
		}
	}
	if f.IncludeTesting {
		_, _ = env.Run.Run(ctx, "fwupdmgr", "enable-remote", "-y", "lvfs-testing")
	} else {
		_, _ = env.Run.Run(ctx, "fwupdmgr", "disable-remote", "lvfs-testing")
	}
	// A refresh fwupd declines as too soon is not a failure.
	_, _ = env.Run.Run(ctx, "fwupdmgr", "refresh")

	pending, err := pendingFirmware(ctx, env)
	if err != nil {
		return []policy.Result{policy.Fail("firmware_updates", err)}
	}
	body, _ := json.Marshal(pending)
	if err := env.WriteFile(firmwarePendingPath, string(body)+"\n", 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("firmware_updates", err)}
	}
	if len(pending) == 0 || f.Mode != "install" {
		result := policy.Ok("firmware_updates")
		if len(pending) > 0 {
			result.Reason = describeFirmware(pending)
		}
		return []policy.Result{result}
	}

	// Install. fwupd stages most updates for the next boot and applies a
	// few (a dock, a mouse) at once; --no-reboot-check keeps it from
	// insisting on a restart, which is the policy's decision.
	args := []string{"fwupdmgr", "update", "-y", "--no-reboot-check"}
	if out, err := Unsandboxed(ctx, env, args[0], args[1:]...); err != nil {
		return []policy.Result{policy.Fail("firmware_updates",
			fmt.Errorf("installing firmware: %w: %s", err, lastLine(out)))}
	}
	result := policy.Ok("firmware_updates")
	result.Reason = "installed: " + describeFirmware(pending)
	if f.RebootWhenNeeded {
		if out, _ := env.Run.Run(ctx, "fwupdmgr", "get-updates", "--json"); strings.Contains(out, "\"Flags\"") {
			// Something remains that needs the reboot to finish.
			_, _ = env.Run.Run(ctx, "systemd-run", "--quiet", "--on-active=60",
				"--unit=odm-firmware-reboot", "systemctl", "reboot")
			result.Reason += "; restarting in a minute to finish"
		}
	}
	return []policy.Result{result}
}

// pendingFirmware asks fwupd what it could update, in the shape the
// inventory carries. An empty answer is a machine with nothing to do, which
// fwupd reports with a non-zero exit and a sentence; both are fine.
func pendingFirmware(ctx context.Context, env Env) ([]FirmwareUpdate, error) {
	out, err := env.Run.Run(ctx, "fwupdmgr", "get-updates", "--json")
	if err != nil && !strings.Contains(strings.ToLower(out+err.Error()), "no updat") {
		if strings.TrimSpace(out) == "" {
			return nil, err
		}
	}
	return parseFirmware(out), nil
}

// parseFirmware reads fwupdmgr's --json: {"Devices":[{"Name":..,"Version":..,
// "Releases":[{"Version":..,"Summary":..}]}]}.
func parseFirmware(raw string) []FirmwareUpdate {
	var doc struct {
		Devices []struct {
			Name     string `json:"Name"`
			Version  string `json:"Version"`
			Releases []struct {
				Version string `json:"Version"`
				Summary string `json:"Summary"`
			} `json:"Releases"`
		} `json:"Devices"`
	}
	start := strings.Index(raw, "{")
	if start < 0 || json.Unmarshal([]byte(raw[start:]), &doc) != nil {
		return nil
	}
	var pending []FirmwareUpdate
	for _, device := range doc.Devices {
		if len(device.Releases) == 0 {
			continue
		}
		newest := device.Releases[0]
		pending = append(pending, FirmwareUpdate{
			Device: device.Name, Current: device.Version, Version: newest.Version, Summary: newest.Summary,
		})
	}
	return pending
}

func describeFirmware(pending []FirmwareUpdate) string {
	parts := make([]string, 0, len(pending))
	for _, update := range pending {
		parts = append(parts, fmt.Sprintf("%s %s → %s", update.Device, update.Current, update.Version))
	}
	return strings.Join(parts, "; ")
}

// PendingFirmware is what the last apply found, for the inventory.
func PendingFirmware(env Env) []FirmwareUpdate {
	raw, err := os.ReadFile(env.Path(firmwarePendingPath))
	if err != nil {
		return nil
	}
	var pending []FirmwareUpdate
	_ = json.Unmarshal(raw, &pending)
	return pending
}
