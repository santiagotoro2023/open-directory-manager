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
	if _, err := net.LookupHost(controller); err == nil {
		return nil
	}
	// --server given as an address is the operator telling us where the
	// domain is. That machine is a domain controller, so it is also the
	// domain's DNS.
	if net.ParseIP(controller) != nil {
		return pointResolver(ctx, options, controller, env)
	}
	return fmt.Errorf(
		"%s does not resolve from this machine, so no controller can be found. "+
			"A domain member uses the domain's own DNS: set this machine's resolver to a "+
			"domain controller, or pass --server with the controller's IP address and the "+
			"join will do it",
		controller,
	)
}

func pointResolver(ctx context.Context, options Options, address string, env Env) error {
	body := managed + fmt.Sprintf("search %s\nnameserver %s\n", options.Domain, address)

	// systemd-resolved owns resolv.conf as a symlink and would put its own
	// back. Tell it instead, on the interface that reaches the controller.
	if link, err := os.Lstat(env.Path(ResolvConfPath)); err == nil &&
		link.Mode()&os.ModeSymlink != 0 && env.Run != nil {
		iface := interfaceTowards(ctx, address, env)
		if iface != "" {
			_, first := env.Run.Run(ctx, "resolvectl", "dns", iface, address)
			_, second := env.Run.Run(ctx, "resolvectl", "domain", iface, options.Domain)
			if first == nil && second == nil {
				return nil
			}
		}
	}

	if err := env.Backup(ResolvConfPath); err != nil {
		return err
	}
	// Replace the symlink rather than writing through it.
	_ = os.Remove(env.Path(ResolvConfPath))
	return env.WriteFile(ResolvConfPath, body, 0o644)
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
