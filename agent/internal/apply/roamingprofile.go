package apply

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"odm.example.org/agent/internal/policy"
)

// A roaming profile puts somebody's home directory on a share instead of on
// whichever machine they happened to sign in to. It is the same mechanism a
// session host uses for its user profile disks, deliberately: point a
// collection and a policy at the same share and a person has one profile
// across every desktop and every session host in the domain.
//
// Off unless a policy says otherwise. A machine with no roaming-profile
// policy keeps ordinary local home directories, which is what a machine that
// is not part of this should do.

// ProfileStore is where the share itself is mounted. Under /run: a stale
// mount after a crash is not something anybody should have to clean up.
const ProfileStore = "/run/odm/profiles"

// MountProfile puts the user's profile in place of their local home. Any
// failure leaves the local home alone and is returned to be logged — a
// profile that cannot be reached must never be the reason somebody cannot
// sign in.
func MountProfile(ctx context.Context, profile *policy.RoamingProfile, user string, env Env) error {
	if profile == nil || profile.Path == "" {
		return nil
	}
	account, err := lookupAccount(user)
	if err != nil {
		return err
	}
	// Never for root or a machine's own service accounts: they have local
	// homes and must keep them, or the machine cannot be recovered.
	if account.uid < 1000 {
		return nil
	}

	// Theirs before anything else happens. Everything below may fail — the
	// share may be down, the ticket refused — and what it must never leave
	// behind is a home directory owned by root: nothing in the session can
	// write to one, including the X server, so a session host with a home
	// like that answered "X server could not be started" on every connection.
	if err := ensureHome(account); err != nil {
		return err
	}

	// Already attached — a second session for the same person on the same
	// machine, or one the display manager opened before this one. Mounting
	// again fails with "is already mounted", and that failure used to take
	// the rest of the logon-time work down with it.
	if mounted(account.home) {
		return nil
	}

	share, subPath, err := splitProfilePath(profile.Path, user)
	if err != nil {
		return err
	}
	if err := mountShare(ctx, share, account, env); err != nil {
		return err
	}

	target := ProfileStore
	if subPath != "" {
		target = filepath.Join(ProfileStore, subPath)
	}
	if err := os.MkdirAll(target, 0o700); err != nil {
		return fmt.Errorf("creating %s on %s: %w", subPath, share, err)
	}

	// A disk unless the policy says otherwise: a desktop expects a real
	// filesystem under its home, and one mounted straight over SMB cannot
	// rename dconf's database into place, which stalls every application that
	// saves a setting.
	switch profile.Kind {
	case "directory":
		err = bindDirectory(ctx, target, account, env)
	default:
		err = attachDisk(ctx, target, user, account, profile.DiskGB, env)
	}
	if err != nil {
		return err
	}

	seedFromSkel(account)
	_ = os.Chown(account.home, account.uid, account.gid)
	_ = os.Chmod(account.home, 0o700)
	return nil
}

// ReleaseProfile unmounts at the end of a session. Never an error: a session
// ending must finish either way, and what is left behind is a mount, not data.
func ReleaseProfile(ctx context.Context, user string, env Env) {
	account, err := lookupAccount(user)
	if err != nil || account.uid < 1000 {
		return
	}
	// Flushed before it is detached. A profile disk holds the settings the
	// desktop wrote during the session, and a page still in memory when the
	// loop device goes is a setting somebody chose and did not keep.
	_, _ = env.Run.Run(ctx, "sync", "-f", account.home)

	// The session manager closes the PAM session before the last of the
	// person's processes has gone, so a plain umount answers "target is busy"
	// and the disk stays attached until the machine is restarted. Tried a few
	// times over a couple of seconds first, because the processes are on their
	// way out and usually beat that; detached lazily if they do not, which
	// takes the mount out of the namespace now and releases the loop device
	// when the last reference goes.
	detached := false
	for attempt := range releaseAttempts {
		if _, err := env.Run.Run(ctx, "umount", account.home); err == nil {
			detached = true
			break
		}
		if attempt < releaseAttempts-1 {
			time.Sleep(releaseWait)
		}
	}
	if !detached {
		if _, err := env.Run.Run(ctx, "umount", "-l", account.home); err != nil {
			// Said out loud. Discarded, this was a profile that quietly
			// stayed mounted and a home directory somebody found afterwards.
			_, _ = env.Run.Run(ctx, "logger", "-t", "odm-profile",
				user+"'s profile disk could not be detached")
		}
	}
	// And the mount point with it. rmdir removes an empty directory and
	// nothing else, so a home still holding files — one whose disk never
	// attached — is left exactly as it is.
	_ = os.Remove(account.home)

	// The share itself only when nobody else is on it. Another session on this
	// machine still needs it.
	if !anyProfileMounted(account.home) {
		_, _ = env.Run.Run(ctx, "umount", ProfileStore)
	}
}

// How hard the unmount tries before giving up and detaching lazily.
const (
	releaseAttempts = 5
	releaseWait     = 400 * time.Millisecond
)

// ensureHome makes somebody's home directory theirs, creating it if it is not
// there. Run before a profile is attached and after: a home the agent made as
// root and left is a session that cannot start.
func ensureHome(who account) error {
	// The directories above it are made traversable, and the home itself is
	// not. MkdirAll gives every level the mode asked for, so a home under
	// /home/EXAMPLE/somebody left /home/EXAMPLE at 0700 root and nobody could
	// reach their own home through it — an X server that cannot enter a home
	// does not start, and says only "X server could not be started".
	if parent := filepath.Dir(who.home); parent != "/" && parent != "." {
		if err := os.MkdirAll(parent, 0o755); err != nil {
			return fmt.Errorf("creating %s: %w", parent, err)
		}
		for path := parent; path != "/" && path != "."; path = filepath.Dir(path) {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm()&0o005 == 0o005 {
				break
			}
			_ = os.Chmod(path, info.Mode().Perm()|0o005)
		}
	}
	if err := os.MkdirAll(who.home, 0o700); err != nil {
		return fmt.Errorf("creating %s: %w", who.home, err)
	}
	info, err := os.Stat(who.home)
	if err != nil {
		return err
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) == who.uid {
		return nil
	}
	if err := os.Chown(who.home, who.uid, who.gid); err != nil {
		return fmt.Errorf("giving %s to its owner: %w", who.home, err)
	}
	return os.Chmod(who.home, 0o700)
}

type account struct {
	uid, gid int
	home     string
}

func lookupAccount(user string) (account, error) {
	out, err := exec.Command("getent", "passwd", user).Output()
	if err != nil {
		return account{}, fmt.Errorf("no account named %q on this machine", user)
	}
	fields := strings.Split(strings.TrimSpace(string(out)), ":")
	if len(fields) < 6 {
		return account{}, fmt.Errorf("unreadable passwd entry for %q", user)
	}
	uid, _ := strconv.Atoi(fields[2])
	gid, _ := strconv.Atoi(fields[3])
	home := fields[5]
	if home == "" {
		home = "/home/" + user
	}
	return account{uid: uid, gid: gid, home: home}, nil
}

// splitProfilePath turns //server/share/team/%username% into the share to
// mount and the path within it, with the placeholder filled in.
//
// The placeholder is the point of the setting: one policy for everybody,
// naming a different directory for each of them.
func splitProfilePath(path, user string) (share, sub string, err error) {
	path = strings.ReplaceAll(path, "\\", "/")
	path = strings.ReplaceAll(path, "%username%", strings.ToLower(user))
	trimmed := strings.TrimPrefix(path, "//")
	if trimmed == path {
		return "", "", fmt.Errorf("%q is not a share; it must start with //", path)
	}
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("%q is not a share; it must look like //server/share", path)
	}
	for _, part := range parts[2:] {
		if part == "." || part == ".." {
			return "", "", fmt.Errorf("%q may not contain .. ", path)
		}
	}
	return "//" + parts[0] + "/" + parts[1], strings.Join(parts[2:], "/"), nil
}

// mountShare mounts the profile share with the credentials of the person
// signing in. Their own ticket is the right one for their own profile: the
// alternative is granting every machine in the domain access to everybody's,
// which is a worse thing to have than a profile that occasionally does not
// mount. PAM's session phase runs after their ticket exists, which is why
// this is attached from there and not by the agent's refresh loop.
//
// The machine's own credentials are tried second, for a share deliberately
// set up to let machines mount profiles on people's behalf.
func mountShare(ctx context.Context, share string, who account, env Env) error {
	if mounted(ProfileStore) {
		return nil
	}
	if err := os.MkdirAll(ProfileStore, 0o755); err != nil {
		return err
	}
	attempts := []string{
		fmt.Sprintf("sec=krb5,cruid=%d,vers=3.1.1,noperm", who.uid),
		fmt.Sprintf("sec=krb5,cruid=%d,vers=3.0,noperm", who.uid),
		"sec=krb5,cruid=0,multiuser,vers=3.1.1,noperm",
	}
	var last error
	for _, options := range attempts {
		out, err := env.Run.Run(ctx, "mount", "-t", "cifs", share, ProfileStore, "-o", options)
		if err == nil {
			return nil
		}
		last = fmt.Errorf("mounting %s: %w: %s", share, err, strings.TrimSpace(lastLine(out)))
	}
	return last
}

func bindDirectory(ctx context.Context, target string, who account, env Env) error {
	if err := ensureHome(who); err != nil {
		return err
	}
	_ = os.Chown(target, who.uid, who.gid)
	if _, err := env.Run.Run(ctx, "mount", "--bind", target, who.home); err != nil {
		return fmt.Errorf("attaching the profile to %s: %w", who.home, err)
	}
	return nil
}

// attachDisk is the session host's user profile disk, reachable from an
// ordinary desktop as well. Named for the account and nothing else, so the
// same person gets the same disk on every machine — the uid does not travel,
// and naming it after one meant a different profile on every host.
func attachDisk(
	ctx context.Context, target, user string, who account, sizeGB int, env Env,
) error {
	if sizeGB <= 0 {
		sizeGB = 10
	}
	image := filepath.Join(target, "UPD-"+strings.ToLower(user)+".img")
	if _, err := os.Stat(image); err != nil {
		// Sparse: it takes the space it uses and cannot exceed what it was made.
		if _, err := env.Run.Run(
			ctx, "truncate", "-s", strconv.Itoa(sizeGB)+"G", image,
		); err != nil {
			return fmt.Errorf("creating %s: %w", image, err)
		}
		if _, err := env.Run.Run(ctx, "mkfs.ext4", "-q", "-F", image); err != nil {
			_ = os.Remove(image)
			return fmt.Errorf("formatting %s: %w", image, err)
		}
	}
	if err := ensureHome(who); err != nil {
		return err
	}
	if _, err := env.Run.Run(ctx, "mount", "-o", "loop,noatime", image, who.home); err != nil {
		return fmt.Errorf("attaching %s: %w", image, err)
	}
	return nil
}

// seedFromSkel gives a brand new profile the same starting point a brand new
// local home gets. Without it the first sign-in lands in an empty directory
// and the desktop comes up with none of its defaults.
func seedFromSkel(who account) {
	entries, err := os.ReadDir(who.home)
	if err != nil || len(entries) > 1 {
		return // not new; lost+found alone is a freshly made disk
	}
	if len(entries) == 1 && entries[0].Name() != "lost+found" {
		return
	}
	_ = exec.Command("cp", "-a", "/etc/skel/.", who.home+"/").Run()
	_ = exec.Command("chown", "-R",
		strconv.Itoa(who.uid)+":"+strconv.Itoa(who.gid), who.home).Run()
}

func mounted(path string) bool {
	return exec.Command("mountpoint", "-q", path).Run() == nil
}

// anyProfileMounted reports whether another session on this machine still has
// a profile attached, so the last one out unmounts the share and the others
// leave it alone.
func anyProfileMounted(except string) bool {
	raw, err := os.ReadFile("/proc/self/mounts")
	if err != nil {
		return true // unknown: leave the share mounted rather than break a session
	}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		target := fields[1]
		if target != except && strings.HasPrefix(target, "/home/") {
			return true
		}
	}
	return false
}
