package join

import (
	"context"
	"fmt"
	"net"
	"os"
	"strings"
)

// A domain member resolves names with the domain's own DNS. Without it
// nothing works: net ads join cannot find a controller, SSSD cannot find the
// LDAP servers, and Kerberos cannot find the KDC. On a real network DHCP
// hands it out; on a machine that has not been given it, joining used to fail
// with
//
//	failed to find DC for domain CORP
//
// which says nothing about DNS at all.

const ResolvConfPath = "/etc/resolv.conf"

// EnsureDomainResolves points this machine at the domain's DNS when it can,
// and explains what to do when it cannot.
func EnsureDomainResolves(ctx context.Context, options Options, controller string, env Env) error {
	// A dry run changes nothing, and a test root is not this machine.
	if options.DryRun || env.Root != "" {
		return nil
	}
	// The domain, not the controller: LookupHost on an address answers
	// immediately without asking anything, so checking --server given as an
	// IP would always say the resolver is fine when it is not. What has to
	// resolve is the domain's own records, which is what net, SSSD and
	// Kerberos all look for.
	//
	// Resolving right now is not enough to leave alone, though. A machine that
	// only resolves the domain because DHCP happens to hand out a controller,
	// or because somebody edited resolv.conf by hand, stops being a domain
	// member at its next reboot. Once this machine is joining, the domain's DNS
	// is pinned to the connection.
	if address := controllerAddress(controller); address != "" {
		if err := pointResolver(ctx, options, address, env); err == nil {
			return nil
		}
	}
	if resolves(options.Domain) {
		return nil
	}
	return fmt.Errorf(
		"%s does not resolve from this machine, so no controller can be found. "+
			"A domain member uses the domain's own DNS: set this machine's resolver to a "+
			"domain controller, or pass --server with the controller's IP address and the "+
			"join will do it",
		controller,
	)
}

// controllerAddress turns whatever --server was into an address to point the
// resolver at, resolving a name if the current resolver can still do it.
func controllerAddress(controller string) string {
	if net.ParseIP(controller) != nil {
		return controller
	}
	addresses, err := net.LookupHost(controller)
	if err != nil || len(addresses) == 0 {
		return ""
	}
	for _, address := range addresses {
		if ip := net.ParseIP(address); ip != nil && ip.To4() != nil {
			return address
		}
	}
	return addresses[0]
}

func pointResolver(ctx context.Context, options Options, address string, env Env) error {
	if env.Run != nil {
		iface := interfaceTowards(ctx, address, env)
		if networkManagerDNS(ctx, options, address, iface, env) == nil && resolves(options.Domain) {
			return nil
		}
		if resolvedDNS(ctx, options, address, env) == nil && resolves(options.Domain) {
			return nil
		}
	}

	if err := env.Backup(ResolvConfPath); err != nil {
		return err
	}
	// Replace the symlink rather than writing through it.
	_ = os.Remove(env.Path(ResolvConfPath))
	body := managed + fmt.Sprintf("search %s\nnameserver %s\n", options.Domain, address)
	return env.WriteFile(ResolvConfPath, body, 0o644)
}

func resolves(domain string) bool {
	_, err := net.LookupHost(domain)
	return err == nil
}

// NetworkManager keeps a connection profile on disk, so DNS set on the
// profile is still there next boot. ignore-auto-dns is the part that matters:
// without it DHCP's servers are merged in ahead and the domain still does not
// resolve.
func networkManagerDNS(ctx context.Context, options Options, address, iface string, env Env) error {
	if iface == "" {
		return fmt.Errorf("no interface reaches %s", address)
	}
	if out, err := env.Run.Run(ctx, "systemctl", "is-active", "NetworkManager"); err != nil ||
		strings.TrimSpace(out) != "active" {
		return fmt.Errorf("NetworkManager is not running")
	}
	out, err := env.Run.Run(ctx, "nmcli", "-t", "-g", "GENERAL.CON-UUID", "device", "show", iface)
	if err != nil {
		return err
	}
	uuid := strings.TrimSpace(out)
	if uuid == "" || uuid == "--" {
		return fmt.Errorf("%s has no NetworkManager connection", iface)
	}
	for _, args := range [][]string{
		{"connection", "modify", uuid, "ipv4.dns", address},
		{"connection", "modify", uuid, "ipv4.dns-search", options.Domain},
		{"connection", "modify", uuid, "ipv4.ignore-auto-dns", "yes"},
		{"connection", "up", uuid},
	} {
		if _, err := env.Run.Run(ctx, "nmcli", args...); err != nil {
			return err
		}
	}
	return nil
}

// systemd-resolved without NetworkManager. A drop-in is configuration rather
// than runtime state, so it survives both a reboot and a DHCP renewal. The
// routing domain is what sends the domain's own names to the controller while
// everything else keeps going wherever it went before.
func resolvedDNS(ctx context.Context, options Options, address string, env Env) error {
	if out, err := env.Run.Run(ctx, "systemctl", "is-active", "systemd-resolved"); err != nil ||
		strings.TrimSpace(out) != "active" {
		return fmt.Errorf("systemd-resolved is not running")
	}
	body := managed + fmt.Sprintf(
		"[Resolve]\nDNS=%s\nDomains=%s ~%s\n", address, options.Domain, options.Domain,
	)
	if err := env.WriteFile("/etc/systemd/resolved.conf.d/odm-domain.conf", body, 0o644); err != nil {
		return err
	}
	_, err := env.Run.Run(ctx, "systemctl", "restart", "systemd-resolved")
	return err
}

func interfaceTowards(ctx context.Context, address string, env Env) string {
	out, err := env.Run.Run(ctx, "ip", "-o", "route", "get", address)
	if err != nil {
		return ""
	}
	fields := strings.Fields(out)
	for i, field := range fields {
		if field == "dev" && i+1 < len(fields) {
			return fields[i+1]
		}
	}
	return ""
}
