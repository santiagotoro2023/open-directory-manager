package apply

import (
	"context"
	"fmt"
	"os"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// A machine taking the name the Computer names policy assigned.
//
// Order matters, because the old identity is what authenticates the request
// for the new one. The console is asked first, while the old ticket still
// works: it renames the account in place and hands back a keytab under the
// new principals. Only then does the machine change: keytab written,
// hostname set, /etc/hosts corrected, SSSD's cache of the old name cleared
// and SSSD restarted so it registers the new name in DNS, and the agent
// restarted a moment later so its next poll is made as the machine it now
// is. A domain controller, or a machine carrying roles, is never renamed
// from here: its services were set up under the name they have.

func applyHostname(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.Hostname == nil || s.Hostname.Wanted == "" {
		return nil
	}
	wanted := strings.ToLower(s.Hostname.Wanted)
	current, _ := os.Hostname()
	current = strings.ToLower(strings.TrimSpace(current))
	if current == wanted || strings.HasPrefix(current, wanted+".") {
		return []policy.Result{policy.Ok("hostname")}
	}
	if env.Run == nil || env.Rename == nil {
		return []policy.Result{policy.Skip("hostname", "no way to ask the console for a rename")}
	}
	if _, err := os.Stat(env.Path("/var/lib/samba/private/sam.ldb")); err == nil {
		return []policy.Result{policy.Skip("hostname", "a domain controller keeps its name")}
	}
	if _, err := os.Stat(env.Path("/etc/samba/smb.conf")); err == nil {
		if raw, readErr := os.ReadFile(env.Path("/etc/samba/smb.conf")); readErr == nil &&
			strings.Contains(strings.ToLower(string(raw)), "[global]") &&
			strings.Contains(strings.ToLower(string(raw)), "server role") &&
			!strings.Contains(strings.ToLower(string(raw)), "server role = member") {
			return []policy.Result{policy.Skip("hostname", "a Samba server keeps its name")}
		}
	}

	fqdn, keytab, err := env.Rename(ctx, wanted)
	if err != nil {
		return []policy.Result{policy.Fail("hostname", fmt.Errorf("asking the console to rename %s to %s: %w", current, wanted, err))}
	}
	keytabPath := env.KeytabPath
	if keytabPath == "" {
		keytabPath = "/etc/krb5.keytab"
	}
	if err := os.WriteFile(env.Path(keytabPath), keytab, 0o600); err != nil {
		return []policy.Result{policy.Fail("hostname", fmt.Errorf("writing the new keytab: %w", err))}
	}
	if _, err := env.Run.Run(ctx, "hostnamectl", "set-hostname", fqdn); err != nil {
		return []policy.Result{policy.Fail("hostname", fmt.Errorf("setting the host name: %w", err))}
	}
	if err := rewriteHosts(env, current, fqdn); err != nil {
		return []policy.Result{policy.Fail("hostname", err)}
	}
	// SSSD knows the machine by its old name until told otherwise; the cache
	// goes and the service restarts, which is also what registers the new
	// name in DNS.
	_, _ = env.Run.Run(ctx, "sss_cache", "-E")
	_, _ = env.Run.Run(ctx, "systemctl", "restart", "sssd")
	_, _ = env.Run.Run(ctx, "systemd-run",
		"--on-active=5", "--timer-property=AccuracySec=1s", "--collect", "--quiet",
		"--unit=odm-agent-restart", "systemctl", "restart", "odm-agent")
	result := policy.Ok("hostname")
	result.Reason = fmt.Sprintf("renamed %s to %s; the agent restarts in a moment", current, fqdn)
	return []policy.Result{result}
}

// rewriteHosts points the machine's own address at its new name. Debian
// keeps the local name on a 127.0.1.1 line; the join wrote the real address
// against the old name. Both are rewritten, and nothing else is touched.
func rewriteHosts(env Env, oldFQDN, newFQDN string) error {
	path := env.Path("/etc/hosts")
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			raw = nil
		} else {
			return fmt.Errorf("reading /etc/hosts: %w", err)
		}
	}
	oldShort := strings.SplitN(oldFQDN, ".", 2)[0]
	newShort := strings.SplitN(newFQDN, ".", 2)[0]
	var out []string
	rewritten := false
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && !strings.HasPrefix(fields[0], "#") {
			names := fields[1:]
			mentions := false
			for _, name := range names {
				if strings.EqualFold(name, oldFQDN) || strings.EqualFold(name, oldShort) {
					mentions = true
				}
			}
			if mentions {
				out = append(out, fields[0]+"\t"+newFQDN+" "+newShort)
				rewritten = true
				continue
			}
		}
		out = append(out, line)
	}
	if !rewritten {
		out = append(out, "127.0.1.1\t"+newFQDN+" "+newShort)
	}
	return os.WriteFile(path, []byte(strings.Join(out, "\n")), 0o644)
}
