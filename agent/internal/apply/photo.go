package apply

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// A person's picture comes from the directory, so it is the same picture on
// every machine they sign in to. Set it once in the console and it follows
// them; set it in a desktop's own settings and it stays on that desktop, which
// is what happened before this existed.
//
// Written to both places a Linux desktop looks:
//
//   - ~/.face, which is the convention and travels with a roaming profile.
//   - AccountsService, which is what GNOME's greeter and Settings read, and
//     which is per-machine — so it is written on each machine at logon rather
//     than being expected to roam.
const accountsServiceIcons = "/var/lib/AccountsService/icons"
const accountsServiceUsers = "/var/lib/AccountsService/users"

// ApplyPhoto puts this person's picture where the desktop will find it.
// Returns nil when there is no picture: an account without one keeps whatever
// the machine already shows rather than having it taken away.
func ApplyPhoto(photo, user string, env Env) error {
	if photo == "" {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(photo)
	if err != nil {
		return fmt.Errorf("the picture is not base64: %w", err)
	}
	who, err := lookupAccount(user)
	if err != nil || who.uid < 1000 {
		return err
	}

	face := filepath.Join(who.home, ".face")
	if err := os.WriteFile(face, raw, 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", face, err)
	}
	_ = os.Chown(face, who.uid, who.gid)

	// AccountsService keys its files on the name the machine knows, which on a
	// domain member may carry the domain.
	name := strings.ToLower(user)
	if err := os.MkdirAll(accountsServiceIcons, 0o755); err != nil {
		return nil // no AccountsService here; ~/.face is enough
	}
	icon := filepath.Join(accountsServiceIcons, name)
	if err := os.WriteFile(icon, raw, 0o644); err != nil {
		return nil
	}
	if err := os.MkdirAll(accountsServiceUsers, 0o700); err != nil {
		return nil
	}
	body := "[User]\nIcon=" + icon + "\nSystemAccount=false\n"
	_ = os.WriteFile(filepath.Join(accountsServiceUsers, name), []byte(body), 0o600)
	return nil
}
