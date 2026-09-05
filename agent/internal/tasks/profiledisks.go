package tasks

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"odm.example.org/agent/internal/apply"
)

// The profile disks on a collection's share.
//
// A disk that has filled up is a person whose desktop will not start, and
// finding that out currently means signing in to a session host and running
// du. Listed and managed from the console instead: how big each is, how much
// of it is used, how big it may grow, and the two operations an operator
// actually performs — make one bigger, and put a broken one aside so the next
// sign-in builds a fresh one.

// profileDisk is one person's disk on the share.
type profileDisk struct {
	User string `json:"user"`
	Path string `json:"path"`
	// What the image occupies on the share, which is less than its size while
	// it is sparse.
	UsedBytes int64 `json:"used_bytes"`
	// How big the filesystem inside it may grow to.
	SizeBytes int64 `json:"size_bytes"`
	// Whether somebody is signed in with it right now, in which case it must
	// not be touched.
	InUse    bool   `json:"in_use"`
	Modified string `json:"modified,omitempty"`
}

// listProfileDisks reads the share this host mounts profiles from.
func listProfileDisks(ctx context.Context, _ map[string]any, env apply.Env) (string, error) {
	store, err := profileStore(ctx, env)
	if err != nil {
		return "", err
	}
	mounted := mountedProfiles(env)

	var disks []profileDisk
	walkErr := filepath.WalkDir(store, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			// A directory this host cannot read is one person's profile, not
			// a reason to answer nothing about everybody else's.
			return nil //nolint:nilerr // deliberate: keep listing
		}
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "UPD-") ||
			!strings.HasSuffix(entry.Name(), ".img") {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		user := strings.TrimSuffix(strings.TrimPrefix(entry.Name(), "UPD-"), ".img")
		disks = append(disks, profileDisk{
			User:      user,
			Path:      strings.TrimPrefix(path, env.Path("/")),
			SizeBytes: info.Size(),
			UsedBytes: onDisk(info),
			InUse:     mounted[user],
			Modified:  info.ModTime().UTC().Format("2006-01-02T15:04:05Z"),
		})
		return nil
	})
	if walkErr != nil {
		return "", fmt.Errorf("reading %s: %w", store, walkErr)
	}
	sort.Slice(disks, func(a, b int) bool { return disks[a].User < disks[b].User })

	body, err := json.Marshal(map[string]any{"store": store, "disks": disks})
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// manageProfileDisk grows a disk or puts a broken one aside.
func manageProfileDisk(
	ctx context.Context, payload map[string]any, env apply.Env,
) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	user := strings.ToLower(strings.TrimSpace(str(payload["user"])))
	if !safeName.MatchString(user) {
		return "", fmt.Errorf("%q is not an account name", user)
	}
	action := str(payload["action"])

	store, err := profileStore(ctx, env)
	if err != nil {
		return "", err
	}
	image := filepath.Join(store, "UPD-"+user+".img")
	if _, err := os.Stat(image); err != nil {
		return "", fmt.Errorf("%s has no profile disk on this share", user)
	}
	// Never while somebody is using it: growing a mounted image corrupts it,
	// and renaming one out from under a session loses the work in it.
	if mountedProfiles(env)[user] {
		return "", fmt.Errorf("%s is signed in; sign them out before changing their profile disk", user)
	}

	switch action {
	case "grow":
		gigabytes := intOf(payload["size_gb"], 0)
		if gigabytes < 1 || gigabytes > 2048 {
			return "", fmt.Errorf("a profile disk may be between 1 and 2048 GB")
		}
		if info, err := os.Stat(image); err == nil && info.Size() >= int64(gigabytes)<<30 {
			return "", fmt.Errorf(
				"%s's disk is already %d GB; a profile disk is never made smaller, because "+
					"what is past the new end goes with it", user, info.Size()>>30)
		}
		// The image, then the filesystem in it. Checked first, because
		// resize2fs refuses a filesystem it has not checked and a refusal
		// here is better than a half-grown one.
		if err := os.Truncate(image, int64(gigabytes)<<30); err != nil {
			return "", err
		}
		if out, err := env.Run.Run(ctx, "e2fsck", "-p", "-f", image); err != nil {
			return out, fmt.Errorf("checking %s's disk: %w", user, err)
		}
		if out, err := env.Run.Run(ctx, "resize2fs", image); err != nil {
			return out, fmt.Errorf("growing %s's disk: %w", user, err)
		}
		return fmt.Sprintf("%s's profile disk may now grow to %d GB", user, gigabytes), nil

	case "reset":
		// Renamed, never deleted. A profile that will not mount still holds
		// somebody's work, and the next sign-in builds a fresh one beside it.
		aside := image + ".broken"
		for index := 1; ; index++ {
			if _, err := os.Stat(aside); os.IsNotExist(err) {
				break
			}
			aside = fmt.Sprintf("%s.broken.%d", image, index)
		}
		if err := os.Rename(image, aside); err != nil {
			return "", err
		}
		return fmt.Sprintf(
			"%s's profile disk is set aside as %s; their next sign-in builds a new one",
			user, filepath.Base(aside)), nil
	}
	return "", fmt.Errorf("unknown action %q", action)
}

// onDisk is what a sparse image actually occupies on the share, which is what
// fills a file server up — its apparent size is what it may grow to.
func onDisk(info os.FileInfo) int64 {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return stat.Blocks * 512
	}
	return info.Size()
}

// profileStore is where this host has the collection's share mounted. Mounted
// by the logon hook, so it is there whenever anybody has signed in since the
// last reboot; mounted here if nobody has.
func profileStore(ctx context.Context, env apply.Env) (string, error) {
	store := env.Path("/run/odm/profiles")
	if entries, err := os.ReadDir(store); err == nil && len(entries) > 0 {
		return store, nil
	}
	// Nothing there: either nobody has signed in yet, or this host has no
	// profile share at all. The collection's own settings say which.
	conf, err := os.ReadFile(env.Path(rdProfileSecrets))
	if err != nil {
		return "", fmt.Errorf("this machine is not a session host in a collection")
	}
	share := ""
	for _, line := range strings.Split(string(conf), "\n") {
		if value, ok := strings.CutPrefix(line, "PROFILE_SHARE="); ok {
			share = strings.TrimSpace(value)
		}
	}
	if share == "" {
		return "", fmt.Errorf("this collection has no profile share")
	}
	// The share itself; the per-person path inside it is what is listed.
	rest := strings.TrimPrefix(share, "//")
	parts := strings.SplitN(rest, "/", 3)
	if len(parts) < 2 {
		return "", fmt.Errorf("the collection's profile share is not a share")
	}
	if err := os.MkdirAll(store, 0o700); err != nil {
		return "", err
	}
	if out, err := env.Run.Run(ctx, "mount", "-t", "cifs",
		"//"+parts[0]+"/"+parts[1], store,
		"-o", "sec=krb5,cruid=0,vers=3.1.1,noperm"); err != nil {
		return "", fmt.Errorf("mounting the profile share: %s", strings.TrimSpace(out))
	}
	return store, nil
}

// mountedProfiles is whose disk is attached right now, by the home directory
// it is attached over.
func mountedProfiles(env apply.Env) map[string]bool {
	found := map[string]bool{}
	raw, err := os.ReadFile(env.Path("/proc/mounts"))
	if err != nil {
		return found
	}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.HasPrefix(fields[1], "/home/") {
			continue
		}
		found[strings.ToLower(filepath.Base(fields[1]))] = true
	}
	return found
}
