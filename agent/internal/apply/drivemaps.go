package apply

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Drive maps (CLAUDE.md §3.5, §5.2).
//
// Mounted with cifs and sec=krb5, so no credential is ever stored on a
// client: single sign-on rides the person's own Kerberos ticket.
//
// Which is also why they are mounted when somebody signs in rather than by
// systemd. A .mount unit is started by the machine, and the machine has no
// ticket: the automount came up and every access answered "No such device",
// because the only credential available at that moment belonged to nobody.
// Mounting from the session hook, with cruid set to the person signing in, is
// the same mechanism the roaming profile uses and the one that works.
//
// multiuser, so a second person signing in to the same machine reaches the
// same mount point with their own credentials rather than the first person's.
func applyDriveMaps(_ context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.DriveMaps) == 0 {
		return nil
	}
	results := make([]policy.Result, 0, len(s.DriveMaps))
	for _, drive := range s.DriveMaps {
		setting := "drive_maps:" + drive.Name
		if _, _, ok := splitUNC(drive.UNC); !ok {
			results = append(results, policy.Fail(setting,
				fmt.Errorf("cannot parse share %q", drive.UNC)))
			continue
		}
		if err := os.MkdirAll(env.Path(drive.MountPoint), 0o755); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		results = append(results, policy.Ok(setting))
	}
	return results
}

// MountDriveMaps attaches the maps this person gets, with their own ticket.
// Run from PAM at session open. Every failure is reported and none is fatal:
// a share that is down must not stop somebody signing in.
func MountDriveMaps(
	ctx context.Context, drives []policy.DriveMap, user string, env Env,
) []error {
	if len(drives) == 0 {
		return nil
	}
	who, err := lookupAccount(user)
	if err != nil || who.uid < 1000 {
		return nil
	}
	memberships := groupsOf(user)
	var problems []error
	for _, drive := range drives {
		if !appliesTo(drive.ForPrincipal, user, memberships) {
			continue
		}
		point := env.Path(drive.MountPoint)
		if mounted(point) {
			continue
		}
		if err := os.MkdirAll(point, 0o755); err != nil {
			problems = append(problems, err)
			continue
		}
		unc := strings.ReplaceAll(drive.UNC, "\\", "/")
		options := fmt.Sprintf("sec=krb5,cruid=%d,multiuser", who.uid)
		if drive.Options != "" {
			options += "," + drive.Options
		}
		if out, err := env.Run.Run(
			ctx, "mount", "-t", "cifs", unc, point, "-o", options,
		); err != nil {
			problems = append(problems, fmt.Errorf(
				"%s: %w: %s", drive.Name, err, strings.TrimSpace(lastLine(out))))
			continue
		}
		if err := bookmark(who, drive); err != nil {
			problems = append(problems, err)
		}
	}
	return problems
}

// bookmark puts the mapped drive in the file manager's sidebar.
//
// A drive map that is only a mount point is a drive map nobody finds: it is
// mounted, it works, and it appears nowhere somebody looking for it would
// look. A bookmark is what a file manager shows in the place a drive letter
// occupies on Windows.
func bookmark(who account, drive policy.DriveMap) error {
	path := filepath.Join(who.home, ".config", "gtk-3.0", "bookmarks")
	line := "file://" + drive.MountPoint + " " + drive.Name
	existing, err := os.ReadFile(path)
	if err == nil {
		for _, present := range strings.Split(string(existing), "\n") {
			if strings.TrimSpace(present) == line {
				return nil
			}
		}
	} else if !os.IsNotExist(err) {
		return nil // an unreadable home is the mount's problem, not this one
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil
	}
	body := string(existing)
	if body != "" && !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	if err := os.WriteFile(path, []byte(body+line+"\n"), 0o644); err != nil {
		return fmt.Errorf("%s: adding it to the file manager: %w", drive.Name, err)
	}
	_ = os.Chown(path, who.uid, who.gid)
	_ = os.Chown(filepath.Dir(path), who.uid, who.gid)
	return nil
}

// appliesTo answers whether a map assigned to a user or %group is this
// person's. An unassigned map is everybody's.
func appliesTo(principal, user string, memberships []string) bool {
	if principal == "" {
		return true
	}
	if strings.HasPrefix(principal, "%") {
		want := strings.ToLower(strings.TrimPrefix(principal, "%"))
		for _, group := range memberships {
			if strings.ToLower(group) == want {
				return true
			}
		}
		return false
	}
	return strings.EqualFold(principal, user)
}

func groupsOf(user string) []string {
	out, err := exec.Command("id", "-nG", user).Output()
	if err != nil {
		return nil
	}
	return strings.Fields(string(out))
}

func splitUNC(unc string) (server, share string, ok bool) {
	trimmed := strings.TrimPrefix(strings.ReplaceAll(unc, "\\", "/"), "//")
	server, share, ok = strings.Cut(trimmed, "/")
	return server, strings.TrimSuffix(share, "/"), ok && server != "" && share != ""
}
