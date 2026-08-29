package join

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// LeaveResult reports what actually happened, because leaving has two halves
// and only one of them is guaranteed.
type LeaveResult struct {
	// AccountRemoved is true when the computer account was deleted from the
	// directory. Without a domain credential the machine still leaves, but the
	// account stays behind for an administrator to remove from the console.
	AccountRemoved bool
	Stopped        []string
	Removed        []string
}

// Leave takes this machine out of the domain.
//
// Two different rights are involved and they are not interchangeable. Removing
// the computer account from the directory needs a domain credential that may
// do so. Severing the machine locally needs root on the machine — and root can
// always do it, because root owns the machine; refusing would only mean the
// operator does it by hand and leaves a half-configured host behind.
//
// So: with a credential, both halves happen. Without one, --force does the
// local half and says plainly that the account is still in the directory.
func Leave(ctx context.Context, options Options, env Env, force bool) (*LeaveResult, error) {
	if env.Root == "" && os.Geteuid() != 0 {
		return nil, fmt.Errorf("leaving a domain requires root")
	}
	if options.AdminUser == "" && !force {
		return nil, fmt.Errorf(
			"leaving needs a domain credential to remove this machine's account " +
				"(--admin-user), or --force to disconnect locally and leave the " +
				"account for an administrator to delete",
		)
	}

	result := &LeaveResult{}
	if options.DryRun || env.Run == nil {
		return result, nil
	}

	if options.AdminUser != "" {
		args := []string{"ads", "leave", "-U", options.AdminUser}
		if options.Server != "" {
			args = append(args, "-S", options.Server)
		}
		if _, err := env.Run.RunWithInput(ctx, options.Password+"\n", "net", args...); err != nil {
			if !force {
				return nil, fmt.Errorf("the domain refused to remove this machine: %w", err)
			}
		} else {
			result.AccountRemoved = true
		}
	}

	// Order matters: stop using the domain before removing what proves who we
	// are to it, so nothing is left half-authenticated.
	for _, unit := range []string{"odm-agent.timer", "odm-agent", "sssd"} {
		if _, err := env.Run.Run(ctx, "systemctl", "disable", "--now", unit); err == nil {
			result.Stopped = append(result.Stopped, unit)
		}
	}

	for _, path := range []string{KeytabPath, SssdConfPath, AgentConfigPath} {
		if err := os.Remove(env.Path(path)); err == nil {
			result.Removed = append(result.Removed, path)
		}
	}
	return result, nil
}

// Summary is what the front ends print.
func (r *LeaveResult) Summary(domain string) string {
	var out strings.Builder
	fmt.Fprintf(&out, "This machine has left %s.\n", domain)
	if r.AccountRemoved {
		out.WriteString("Its computer account was removed from the directory.\n")
	} else {
		out.WriteString(
			"Its computer account is still in the directory: delete it under " +
				"Directory in the console, or it will show as a machine that " +
				"stopped reporting.\n",
		)
	}
	if len(r.Stopped) > 0 {
		fmt.Fprintf(&out, "Stopped: %s\n", strings.Join(r.Stopped, ", "))
	}
	if len(r.Removed) > 0 {
		fmt.Fprintf(&out, "Removed: %s\n", strings.Join(r.Removed, ", "))
	}
	return out.String()
}
