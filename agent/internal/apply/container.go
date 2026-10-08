package apply

import (
	"os"

	"odm.example.org/agent/internal/policy"
)

// A domain controller or role server run from the node image
// (deploy/docker/node, docs/CONTAINERS.md) is a container with its own
// systemd, its own packages and its own /etc — and the host's kernel, the
// host's network namespace and the host's name. It needs host networking
// to be a controller at all: DNS, Kerberos and DHCP broadcasts are on the
// host's addresses or nowhere.
//
// So a few settings would not change the machine the policy was written
// for; they would change the Kubernetes or Docker host under it. A firewall
// ruleset in the host's network namespace replaces the rules that host's
// container networking depends on; a sysctl is the host kernel's; a host
// name is the host's own; a firmware update flashes the host's firmware; a
// graphics driver is a module loaded into the host kernel; a boot loader
// setting is for a disk this container does not boot from. Those are
// reported as skipped, with the reason, and never applied — the host is
// managed as whatever it is, not by a container that happens to run on it.
// Everything else applies exactly as on any other member server.

// containerMarkers are the files that say this is a container: systemd's
// own (written when it is started with container=), Docker's and Podman's,
// and the node image's, which is there whatever started it.
var containerMarkers = []string{
	"/etc/odm/container-node",
	"/run/systemd/container",
	"/.dockerenv",
	"/run/.containerenv",
}

// InContainer reports whether the agent runs inside a container.
func InContainer(env Env) bool {
	for _, marker := range containerMarkers {
		if _, err := os.Stat(env.Path(marker)); err == nil {
			return true
		}
	}
	return false
}

// hostOwned names the appliers whose settings belong to the host a container
// runs on, each with whether the policy being applied sets it at all — a
// setting nobody asked for is not worth a line in the report.
var hostOwned = map[string]func(policy.Settings) bool{
	"hostname":         func(s policy.Settings) bool { return s.Hostname != nil && s.Hostname.Wanted != "" },
	"grub":             func(s policy.Settings) bool { return s.Grub != nil },
	"graphics_drivers": func(s policy.Settings) bool { return s.GraphicsDrivers != nil },
	"firmware_updates": func(s policy.Settings) bool {
		return s.FirmwareUpdates != nil && s.FirmwareUpdates.Enabled
	},
	"sysctl":            func(s policy.Settings) bool { return len(s.Sysctl) > 0 },
	"firewall":          func(s policy.Settings) bool { return len(s.Firewall) > 0 },
	"removable_storage": func(s policy.Settings) bool { return s.RemovableStorage != nil },
	"device_control":    func(s policy.Settings) bool { return s.DeviceControl != nil },
	"wifi_networks":     func(s policy.Settings) bool { return len(s.WifiNetworks) > 0 },
	"always_on_vpn": func(s policy.Settings) bool {
		return s.AlwaysOnVpn != nil && s.AlwaysOnVpn.Tunnel != ""
	},
}

const hostOwnedReason = "this machine is a container; the setting belongs to the host it runs on"

// skipForContainer returns what to report instead of running an applier,
// and whether to skip it.
func skipForContainer(name string, s policy.Settings, env Env) ([]policy.Result, bool) {
	wanted, owned := hostOwned[name]
	if !owned || !InContainer(env) {
		return nil, false
	}
	if !wanted(s) {
		return nil, true
	}
	return []policy.Result{policy.Skip(name, hostOwnedReason)}, true
}
