package apply

import (
	"context"
	"fmt"
	"os"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Always-on remote access.
//
// The tunnel is a wg-quick unit, enabled so it comes up at boot before anyone
// signs in — which is the point: a laptop in a home office has its drives and
// its policy without the person doing anything. The unit is root-owned and
// the configuration is 0600, so the person using the machine cannot turn it
// off or read the key.
const (
	clientWireguardDir = "/etc/wireguard"
	vpnDropInDir       = "/etc/systemd/system/wg-quick@.service.d"
	vpnDropInPath      = "/etc/systemd/system/wg-quick@.service.d/odm-always-on.conf"
)

func applyAlwaysOnVpn(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.AlwaysOnVpn == nil || s.AlwaysOnVpn.Tunnel == "" {
		return nil
	}
	settings := *s.AlwaysOnVpn

	// The control plane says so when this machine has no peer on the tunnel.
	// Reporting that is more use than writing a configuration that cannot work.
	if settings.Unavailable != "" {
		return []policy.Result{{
			Setting: "always_on_vpn", Status: "skipped", Reason: settings.Unavailable,
		}}
	}
	config := settings.Configuration
	if config == nil || config.PrivateKey == "" {
		return []policy.Result{{
			Setting: "always_on_vpn",
			Status:  "skipped",
			Reason:  "no configuration was supplied for this machine",
		}}
	}
	if env.Run == nil {
		return []policy.Result{{
			Setting: "always_on_vpn", Status: "skipped", Reason: "no command runner",
		}}
	}

	name := safeInterfaceName(settings.Tunnel)
	body := RenderTunnel(*config, settings.BlockUntilConnected)
	path := fmt.Sprintf("%s/%s.conf", clientWireguardDir, name)

	if err := os.MkdirAll(env.Path(clientWireguardDir), 0o700); err != nil {
		return []policy.Result{policy.Fail("always_on_vpn", err)}
	}
	// 0600 root: the private key is the machine's identity on the tunnel.
	if err := env.WriteFile(path, body, 0o600, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("always_on_vpn", err)}
	}

	// Restart on failure, so a tunnel that drops comes back without anyone
	// noticing — which is what "always on" has to mean.
	dropIn := Header + "[Service]\nRestart=always\nRestartSec=10\n"
	if err := os.MkdirAll(env.Path(vpnDropInDir), 0o755); err != nil {
		return []policy.Result{policy.Fail("always_on_vpn", err)}
	}
	if err := env.WriteFile(vpnDropInPath, dropIn, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("always_on_vpn", err)}
	}

	unit := "wg-quick@" + name
	return []policy.Result{runAll(ctx, env, "always_on_vpn",
		[]string{"systemctl", "daemon-reload"},
		[]string{"systemctl", "enable", unit},
		[]string{"systemctl", "restart", unit},
	)}
}

// RenderTunnel writes the wg-quick configuration for one peer. Exported so
// what reaches /etc/wireguard can be asserted without a network.
func RenderTunnel(config policy.VpnConfiguration, blockUntilConnected bool) string {
	var out strings.Builder
	out.WriteString("# Managed by Open Directory Manager. Edits here are overwritten.\n")
	out.WriteString("[Interface]\n")
	fmt.Fprintf(&out, "Address = %s\n", config.Address)
	fmt.Fprintf(&out, "PrivateKey = %s\n", config.PrivateKey)
	if len(config.DNS) > 0 {
		entries := append([]string{}, config.DNS...)
		if config.SearchDomain != "" {
			entries = append(entries, config.SearchDomain)
		}
		fmt.Fprintf(&out, "DNS = %s\n", strings.Join(entries, ", "))
	}
	if blockUntilConnected {
		// Everything the tunnel claims is dropped until it is up, so a laptop
		// cannot reach those networks over whatever it is plugged into.
		out.WriteString("PostUp = ")
		for index, route := range config.AllowedIPs {
			if index > 0 {
				out.WriteString("; ")
			}
			fmt.Fprintf(&out, "ip route add blackhole %s metric 1000 || true", route)
		}
		out.WriteString("\n")
		out.WriteString("PreDown = ")
		for index, route := range config.AllowedIPs {
			if index > 0 {
				out.WriteString("; ")
			}
			fmt.Fprintf(&out, "ip route del blackhole %s metric 1000 || true", route)
		}
		out.WriteString("\n")
	}

	out.WriteString("\n[Peer]\n")
	fmt.Fprintf(&out, "PublicKey = %s\n", config.PeerPublicKey)
	fmt.Fprintf(&out, "Endpoint = %s\n", config.Endpoint)
	fmt.Fprintf(&out, "AllowedIPs = %s\n", strings.Join(config.AllowedIPs, ", "))
	// Keeps the tunnel alive through a home router's NAT table.
	out.WriteString("PersistentKeepalive = 25\n")
	return out.String()
}

// safeInterfaceName keeps a tunnel name usable as an interface and a unit
// instance. Checked here because it reaches both a path and systemctl.
func safeInterfaceName(name string) string {
	cleaned := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return -1
		}
	}, name)
	if len(cleaned) > 15 {
		// Linux interface names are capped at 15 characters.
		cleaned = cleaned[:15]
	}
	if cleaned == "" {
		cleaned = "odmvpn"
	}
	return cleaned
}
