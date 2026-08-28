package join

import (
	"context"
	"fmt"
	"os"
	"strings"
)

const HostsPath = "/etc/hosts"

// MachineName is what the machine currently calls itself, and what it should
// call itself once it belongs to the domain.
type MachineName struct {
	Current string
	Wanted  string
	Short   string
}

// PlanHostname works out whether the machine needs renaming to join.
//
// A machine with only a short name cannot hold a Kerberos identity in the
// domain: the account, the keytab principal and the certificate subject all
// use the fully-qualified name.
func PlanHostname(options Options) (MachineName, error) {
	current, err := os.Hostname()
	if err != nil {
		return MachineName{}, fmt.Errorf("cannot read this machine's name: %w", err)
	}
	current = strings.TrimSpace(strings.ToLower(current))
	wanted := options.Hostname
	if wanted == "" {
		wanted = current
	}
	if !strings.Contains(wanted, ".") {
		wanted = wanted + "." + options.Domain
	}
	return MachineName{
		Current: current,
		Wanted:  wanted,
		Short:   strings.SplitN(wanted, ".", 2)[0],
	}, nil
}

// NeedsRename reports whether applying the plan would change anything.
func (m MachineName) NeedsRename() bool { return m.Current != m.Wanted }

// ApplyHostname renames the machine and points its own address at the new
// name, so that Kerberos, SSSD and the policy agent all agree on who it is.
func ApplyHostname(ctx context.Context, name MachineName, env Env) error {
	if env.Run == nil {
		return fmt.Errorf("no command runner")
	}
	if _, err := env.Run.Run(ctx, "hostnamectl", "set-hostname", name.Wanted); err != nil {
		return fmt.Errorf("cannot set the host name: %w", err)
	}
	if err := updateHosts(ctx, name, env); err != nil {
		return err
	}
	// Anything already running keeps the old name until it restarts. Nothing
	// that matters for the join has started yet.
	_, _ = env.Run.Run(ctx, "systemctl", "restart", "systemd-hostnamed")
	return nil
}

// updateHosts replaces Debian's 127.0.1.1 short-name line with the machine's
// real address mapped to its fully-qualified name. Running it twice leaves
// the file unchanged.
func updateHosts(ctx context.Context, name MachineName, env Env) error {
	body, err := os.ReadFile(env.Path(HostsPath))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := env.Backup(HostsPath); err != nil {
		return err
	}

	address := primaryAddress(ctx, env)
	kept := make([]string, 0, 8)
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			kept = append(kept, line)
			continue
		}
		if fields[0] == "127.0.1.1" {
			continue
		}
		if containsName(fields[1:], name.Wanted) {
			continue
		}
		kept = append(kept, line)
	}

	out := strings.TrimRight(strings.Join(kept, "\n"), "\n") + "\n"
	if address != "" {
		out += fmt.Sprintf("%s\t%s %s\n", address, name.Wanted, name.Short)
	}
	return env.WriteFile(HostsPath, out, 0o644)
}

func containsName(names []string, wanted string) bool {
	for _, name := range names {
		if name == wanted {
			return true
		}
	}
	return false
}

func primaryAddress(ctx context.Context, env Env) string {
	if env.Run == nil {
		return ""
	}
	out, err := env.Run.Run(ctx, "hostname", "-I")
	if err != nil {
		return ""
	}
	fields := strings.Fields(out)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}
