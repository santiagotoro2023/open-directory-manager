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
func applyDriveMaps(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	results := detachRemoved(ctx, s.DriveMaps, env)
	if len(s.DriveMaps) == 0 {
		return results
	}
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

// detachRemoved takes down the mounts this policy no longer names.
//
// The maps are attached in a session, but they are removed here too: unlinking
// a policy object should take the drive away from the people already signed
// in, not only from whoever signs in next. The sidebar entry and the record of
// what was mounted are left for that next sign-in, which is the only context
// that knows whose sidebar it is.
// Replaced in tests, where nothing is really mounted.
var isMounted = mounted

func detachRemoved(ctx context.Context, drives []policy.DriveMap, env Env) []policy.Result {
	state := loadCreated(env)
	if len(state.DriveMaps) == 0 || env.Run == nil {
		return nil
	}
	wanted := make([]string, 0, len(drives))
	for _, drive := range drives {
		wanted = append(wanted, drive.MountPoint)
	}
	var results []policy.Result
	for _, gone := range goneFrom(state.DriveMaps, wanted) {
		if !isMounted(env.Path(gone)) {
			continue
		}
		setting := "drive_maps:" + gone
		if out, err := env.Run.Run(ctx, "umount", env.Path(gone)); err != nil {
			results = append(results, policy.Result{
				Setting: setting,
				Status:  "failed",
				Reason:  fmt.Sprintf("detaching: %v: %s", err, strings.TrimSpace(lastLine(out))),
			})
			continue
		}
		results = append(results, policy.Result{
			Setting: setting, Status: "success", Reason: "removed: no longer in policy",
		})
	}
	return results
}

// MountDriveMaps attaches the maps this person gets, with their own ticket.
// Run from PAM at session open. Every failure is reported and none is fatal:
// a share that is down must not stop somebody signing in.
func MountDriveMaps(
	ctx context.Context, drives []policy.DriveMap, user string, env Env,
) []error {
	// Not "nothing to do" when the list is empty: a drive map the policy
	// stopped naming still has to be detached.
	if len(drives) == 0 && len(loadCreated(env).DriveMaps) == 0 {
		return nil
	}
	who, err := lookupAccount(user)
	if err != nil || who.uid < 1000 {
		return nil
	}
	memberships := groupsOf(user)
	var problems []error
	attached := []string{}
	for _, drive := range drives {
		if !appliesTo(drive.ForPrincipal, user, memberships) {
			continue
		}
		point := env.Path(drive.MountPoint)
		// In the policy, so it keeps its place in the file manager whether or
		// not this session managed to attach it: a share that is briefly down
		// must not silently un-map somebody's drive.
		attached = append(attached, drive.MountPoint)
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

	// A drive map the policy no longer names goes away, mount and bookmark
	// both: it is not a file, so nothing else takes it back.
	state := loadCreated(env)
	for _, gone := range goneFrom(state.DriveMaps, attached) {
		if mounted(env.Path(gone)) {
			if _, err := env.Run.Run(ctx, "umount", env.Path(gone)); err != nil {
				problems = append(problems, fmt.Errorf("detaching %s: %w", gone, err))
				attached = append(attached, gone) // still here; try again next time
				continue
			}
		}
		unbookmark(who, gone)
	}
	state.DriveMaps = attached
	saveCreated(env, state)
	return problems
}

// unbookmark takes a drive map back out of the file manager's sidebar.
func unbookmark(who account, mountPoint string) {
	path := filepath.Join(who.home, ".config", "gtk-3.0", "bookmarks")
	existing, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var kept []string
	for _, line := range strings.Split(strings.TrimRight(string(existing), "\n"), "\n") {
		if strings.HasPrefix(line, "file://"+mountPoint+" ") || line == "file://"+mountPoint {
			continue
		}
		kept = append(kept, line)
	}
	body := strings.Join(kept, "\n")
	if body != "" {
		body += "\n"
	}
	if os.WriteFile(path, []byte(body), 0o644) == nil {
		_ = os.Chown(path, who.uid, who.gid)
	}
}

// bookmark puts the mapped drive in the file manager's sidebar.
//
// A drive map that is only a mount point is a drive map nobody finds: it is
// mounted, it works, and it appears nowhere somebody looking for it would
// look. A bookmark is what a file manager shows in the place a drive letter
// occupies on Windows.
func bookmark(who account, drive policy.DriveMap) error {
	path := filepath.Join(who.home, ".config", "gtk-3.0", "bookmarks")
	line := "file://" + drive.MountPoint + " " + drive.Label()
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
	if err := makeUnder(who, filepath.Dir(path)); err != nil {
		return nil
	}
	// A label that changed leaves the old line behind, and the sidebar would
	// then hold the same drive twice under two names.
	unbookmark(who, drive.MountPoint)
	existing, _ = os.ReadFile(path)
	body := string(existing)
	if body != "" && !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	if err := os.WriteFile(path, []byte(body+line+"\n"), 0o644); err != nil {
		return fmt.Errorf("%s: adding it to the file manager: %w", drive.Name, err)
	}
	_ = os.Chown(path, who.uid, who.gid)
	return nil
}

// makeUnder creates a directory inside somebody's home and gives them every
// level of it. Creating one as root and chowning only the last leaves the
// parent unreadable to its owner, and the symptom is not a directory anybody
// looks at: "Cannot open dconf database: Permission denied" from every
// application in the session, because ~/.config itself belonged to root.
func makeUnder(who account, dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for path := dir; strings.HasPrefix(path, who.home) && path != who.home; path = filepath.Dir(path) {
		_ = os.Chown(path, who.uid, who.gid)
	}
	return nil
}

// AppliesTo answers whether an entry assigned to a user or %group is this
// person's, asking the system for their groups. Exported for the session
// paths, which report what somebody was meant to get.
func AppliesTo(principal, user string) bool {
	return appliesTo(principal, user, groupsOf(user))
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
