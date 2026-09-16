package apply

import (
	"context"
	"fmt"
	"os"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Wireless networks, as NetworkManager keeps them: one keyfile per network
// under system-connections, owned by root and readable by nobody else, so the
// connection exists for the machine rather than for whoever signed in and is
// up at the login screen.
//
// The 802.1X profile points at the machine certificate that Certificates →
// machine certificate enrols and the trust anchor that Certificates → trust
// the domain's authority installs; both are ordinary paths on the machine,
// so this writes nothing secret of its own. A pre-shared key is the one
// thing here that is a secret, and it goes into a file only root reads.
const (
	nmConnectionDir = "/etc/NetworkManager/system-connections"
	// Where Certificates → trust the domain's authority puts the root; see
	// applyTrustedCertificates for the naming.
	domainAuthorityAnchor = trustAnchorDir + "/odm-domain-authority.crt"
)

func applyWifi(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.WifiNetworks) == 0 {
		return nil
	}
	// A server without NetworkManager has nowhere to put these. Skipped,
	// and said so, rather than a directory created for a program that is
	// not there.
	if _, err := os.Stat(env.Path(nmConnectionDir)); err != nil {
		var results []policy.Result
		for _, network := range s.WifiNetworks {
			results = append(results, policy.Result{
				Setting: "wifi:" + network.SSID, Status: "skipped",
				Reason: "NetworkManager is not installed on this machine",
			})
		}
		return results
	}

	host, _ := os.Hostname()
	var results []policy.Result
	changed := false
	for _, network := range s.WifiNetworks {
		setting := "wifi:" + network.SSID
		body, err := nmKeyfile(network, host)
		if err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		path := nmConnectionDir + "/odm-" + safeFileName(network.SSID) + ".nmconnection"
		before, _ := os.ReadFile(env.Path(path))
		// 0600: NetworkManager refuses a keyfile anyone else can read, and
		// a pre-shared key is in it.
		if err := env.WriteFile(path, body, 0o600, "root", "root"); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		if string(before) != body {
			changed = true
		}
		results = append(results, policy.Ok(setting))
	}
	if changed && env.Run != nil {
		if out, err := env.Run.Run(ctx, "nmcli", "connection", "reload"); err != nil {
			results = append(results, policy.Fail("wifi:reload", fmt.Errorf("%w: %s", err, out)))
		}
	}
	return results
}

// nmKeyfile is the connection as NetworkManager's keyfile plugin reads it.
func nmKeyfile(network policy.WifiNetwork, host string) (string, error) {
	if network.SSID == "" {
		return "", fmt.Errorf("a network needs an SSID")
	}
	var b strings.Builder
	b.WriteString(Header)
	fmt.Fprintf(&b, "[connection]\nid=odm-%s\ntype=wifi\n", network.SSID)
	fmt.Fprintf(&b, "autoconnect=%s\nautoconnect-priority=%d\n", nmBool(network.Autoconnect), network.Priority)
	// A system connection: no permissions line means every user, and the
	// machine itself before any of them.
	b.WriteString("permissions=\n\n")
	fmt.Fprintf(&b, "[wifi]\nssid=%s\nmode=infrastructure\n", network.SSID)
	if network.Hidden {
		b.WriteString("hidden=true\n")
	}
	b.WriteString("\n")

	switch network.Security {
	case "wpa-eap":
		if network.EAP != "" && network.EAP != "tls" {
			return "", fmt.Errorf("unsupported EAP method %q", network.EAP)
		}
		dir := strings.TrimSuffix(network.CertificatePath, "/")
		if dir == "" {
			dir = "/etc/ssl/odm"
		}
		b.WriteString("[wifi-security]\nkey-mgmt=wpa-eap\n\n")
		b.WriteString("[802-1x]\neap=tls;\n")
		// host/<fqdn>: what the RADIUS rules read as a machine rather than
		// a person, and what a Windows client sends for the same thing.
		fmt.Fprintf(&b, "identity=host/%s\n", host)
		fmt.Fprintf(&b, "client-cert=%s/client.crt\nprivate-key=%s/client.key\n", dir, dir)
		// A key the agent wrote has no passphrase; NetworkManager insists
		// the field be present for a PEM key all the same.
		b.WriteString("private-key-password-flags=4\n")
		fmt.Fprintf(&b, "ca-cert=%s\n", domainAuthorityAnchor)
		if network.ServerName != "" {
			fmt.Fprintf(&b, "domain-suffix-match=%s\n", network.ServerName)
		}
		b.WriteString("\n")
	case "wpa-psk":
		if len(network.PSK) < 8 {
			return "", fmt.Errorf("a pre-shared key is at least 8 characters")
		}
		fmt.Fprintf(&b, "[wifi-security]\nkey-mgmt=wpa-psk\npsk=%s\n\n", network.PSK)
	case "open", "":
	default:
		return "", fmt.Errorf("unsupported security %q", network.Security)
	}
	b.WriteString("[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\naddr-gen-mode=default\n")
	return b.String(), nil
}

func nmBool(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

// safeFileName keeps a file name to what a directory listing can hold.
func safeFileName(name string) string {
	var out strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			out.WriteRune(r)
		default:
			out.WriteRune('_')
		}
	}
	if out.Len() == 0 {
		return "network"
	}
	return out.String()
}
