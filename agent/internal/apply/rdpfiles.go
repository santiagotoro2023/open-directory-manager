package apply

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Connection files on somebody's desktop.
//
// Handing out .rdp files is the part of a remote-desktop rollout that never
// finishes: whoever joins next has no icon and whoever leaves keeps theirs.
// Named in a policy against a collection and a group, the file arrives when
// the membership does and goes when the membership or the link goes.
//
// Written in the session, like a drive map, because it lands in a home
// directory and is decided by who is signing in.

// DeployRemoteDesktopFiles writes the files this person gets and removes the
// ones they no longer do. Run from PAM at session open.
func DeployRemoteDesktopFiles(
	ctx context.Context, files []policy.RemoteDesktopFile, user string, env Env,
) []error {
	// Not "nothing to do" when the list is empty: a file this person has
	// stopped being entitled to has to go.
	state := loadCreated(env)
	if len(files) == 0 && len(state.RemoteDesktopFiles) == 0 {
		return nil
	}
	who, err := lookupAccount(user)
	if err != nil || who.uid < 1000 {
		return nil
	}

	desktop := desktopDir(who)
	memberships := groupsOf(user)
	var problems []error
	written := []string{}

	for _, file := range files {
		if !appliesTo(file.ForPrincipal, user, memberships) {
			continue
		}
		path := filepath.Join(desktop, safeName(file.Name)+".rdp")
		if err := makeUnder(who, desktop); err != nil {
			problems = append(problems, fmt.Errorf("%s: %w", file.Name, err))
			continue
		}
		if err := os.WriteFile(path, []byte(rdpBody(file, user, env)), 0o644); err != nil {
			problems = append(problems, fmt.Errorf("%s: %w", file.Name, err))
			continue
		}
		_ = os.Chown(path, who.uid, who.gid)
		written = append(written, path)
	}

	// What this person had and no longer gets. Only files this agent wrote:
	// anything else on a desktop is theirs.
	for _, gone := range goneFrom(state.RemoteDesktopFiles, written) {
		if !strings.HasPrefix(gone, who.home) {
			continue // another person's desktop; their own session removes it
		}
		if err := os.Remove(gone); err != nil && !os.IsNotExist(err) {
			problems = append(problems, fmt.Errorf("removing %s: %w", gone, err))
			written = append(written, gone) // still there; try again next time
		}
	}

	// The record is this person's files plus everybody else's, so one session
	// does not forget another's.
	state.RemoteDesktopFiles = merge(state.RemoteDesktopFiles, written, who.home)
	saveCreated(env, state)
	return problems
}

// safeName keeps a name to what may be a file name: the value is validated by
// the control plane, and this is the second pair of eyes on a path.
func safeName(name string) string {
	cleaned := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case r == '.' || r == '_' || r == '-' || r == ' ':
			return r
		}
		return '-'
	}, name)
	cleaned = strings.TrimLeft(cleaned, ".-")
	if cleaned == "" {
		return "remote-desktop"
	}
	if len(cleaned) > 64 {
		cleaned = cleaned[:64]
	}
	return cleaned
}

// merge keeps what other people's sessions wrote and replaces this person's.
func merge(previous, current []string, home string) []string {
	kept := make([]string, 0, len(previous)+len(current))
	for _, path := range previous {
		if !strings.HasPrefix(path, home) {
			kept = append(kept, path)
		}
	}
	return append(kept, current...)
}

// desktopDir is where this person's desktop is, which is not always Desktop:
// a localised session records its own name for it.
func desktopDir(who account) string {
	raw, err := os.ReadFile(filepath.Join(who.home, ".config", "user-dirs.dirs"))
	if err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			value, found := strings.CutPrefix(strings.TrimSpace(line), "XDG_DESKTOP_DIR=")
			if !found {
				continue
			}
			value = strings.Trim(strings.TrimSpace(value), `"`)
			value = strings.Replace(value, "$HOME", who.home, 1)
			if strings.HasPrefix(value, who.home) {
				return value
			}
		}
	}
	return filepath.Join(who.home, "Desktop")
}

// rdpBody is the connection file itself: the documented .rdp keys, which
// every client on Debian reads — Remmina, the FreeRDP command line, and
// Windows mstsc if somebody copies it there.
func rdpBody(file policy.RemoteDesktopFile, user string, env Env) string {
	screen := 1
	if file.FullScreen {
		screen = 2
	}
	body := &strings.Builder{}
	fmt.Fprintf(body, "full address:s:%s\n", file.Address)
	// The account, in the form a client sends it. The short domain name comes
	// from the realm the machine is joined to.
	if domain := netbiosOf(env); domain != "" {
		fmt.Fprintf(body, "username:s:%s\\%s\n", domain, shortUser(user))
	} else {
		fmt.Fprintf(body, "username:s:%s\n", shortUser(user))
	}
	fmt.Fprintf(body, "screen mode id:i:%d\n", screen)
	fmt.Fprintf(body, "authentication level:i:2\n")
	fmt.Fprintf(body, "prompt for credentials:i:0\n")
	fmt.Fprintf(body, "redirectclipboard:i:1\n")
	fmt.Fprintf(body, "redirectprinters:i:1\n")
	fmt.Fprintf(body, "audiomode:i:0\n")
	if file.Application != "" {
		// A published application rather than a whole desktop, which is what
		// the two leading bars mean in this format.
		fmt.Fprintf(body, "remoteapplicationmode:i:1\n")
		fmt.Fprintf(body, "alternate shell:s:||%s\n", file.Application)
		fmt.Fprintf(body, "remoteapplicationprogram:s:||%s\n", file.Application)
		if file.Collection != "" {
			fmt.Fprintf(body, "remoteapplicationname:s:%s\n", file.Collection)
		}
	}
	return body.String()
}

// shortUser is the account name without a realm suffix, which is what an RDP
// client expects beside a domain name.
func shortUser(user string) string {
	name, _, _ := strings.Cut(user, "@")
	if _, after, found := strings.Cut(name, `\`); found {
		return after
	}
	return name
}

// netbiosOf reads the domain's short name from the machine's Samba
// configuration, which the domain join wrote.
func netbiosOf(env Env) string {
	raw, err := os.ReadFile(env.Path("/etc/samba/smb.conf"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(raw), "\n") {
		key, value, found := strings.Cut(line, "=")
		if found && strings.EqualFold(strings.TrimSpace(key), "workgroup") {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
