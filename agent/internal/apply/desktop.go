package apply

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Browser policy is written to each vendor's documented managed-policy
// location — these are real enterprise mechanisms, not ODM inventions
// (CLAUDE.md §5.2).
var chromiumPolicyPaths = []string{
	"/etc/chromium/policies/managed/odm.json",
	"/etc/opt/chrome/policies/managed/odm.json",
}

const firefoxPolicyPath = "/etc/firefox/policies/policies.json"

func applyBrowser(_ context.Context, s policy.Settings, env Env) []policy.Result {
	if s.Browser == nil {
		return nil
	}
	var results []policy.Result

	if len(s.Browser.Chromium) > 0 {
		body, err := json.MarshalIndent(s.Browser.Chromium, "", "  ")
		if err != nil {
			results = append(results, policy.Fail("browser:chromium", err))
		} else {
			for _, path := range chromiumPolicyPaths {
				if err := env.WriteFile(path, string(body)+"\n", 0o644, "root", "root"); err != nil {
					results = append(results, policy.Fail("browser:chromium", err))
					break
				}
			}
			if len(results) == 0 {
				results = append(results, policy.Ok("browser:chromium"))
			}
		}
	}

	if len(s.Browser.Firefox) > 0 {
		// Firefox expects its settings nested under a "policies" key.
		body, err := json.MarshalIndent(
			map[string]any{"policies": s.Browser.Firefox}, "", "  ",
		)
		if err != nil {
			results = append(results, policy.Fail("browser:firefox", err))
		} else if err := env.WriteFile(
			firefoxPolicyPath, string(body)+"\n", 0o644, "root", "root",
		); err != nil {
			results = append(results, policy.Fail("browser:firefox", err))
		} else {
			results = append(results, policy.Ok("browser:firefox"))
		}
	}
	return results
}

const (
	dconfProfilePath = "/etc/dconf/profile/user"
	dconfKeyfilePath = "/etc/dconf/db/odm.d/00-odm-desktop"
	dconfLockPath    = "/etc/dconf/db/odm.d/locks/odm-desktop"
)

// Desktop background via a dconf system database (CLAUDE.md §5.2). The
// applier interface is per-setting, so a KDE or other-desktop applier can be
// added later without touching this one.
func applyWallpaper(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.Wallpaper == nil || (s.Wallpaper.URI == "" && s.Wallpaper.Image == "") {
		return nil
	}
	uri, err := backgroundURI(s.Wallpaper.URI, s.Wallpaper.Image, s.Wallpaper.ImageName, env)
	if err != nil {
		return []policy.Result{policy.Fail("wallpaper", err)}
	}
	options := s.Wallpaper.PictureOptions
	if options == "" {
		options = "zoom"
	}

	profile := "user-db:user\nsystem-db:odm\n"
	if err := env.WriteFile(dconfProfilePath, profile, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("wallpaper", err)}
	}

	keyfile := Header + fmt.Sprintf(
		"[org/gnome/desktop/background]\npicture-uri='%s'\npicture-uri-dark='%s'\npicture-options='%s'\n",
		dconfEscape(uri), dconfEscape(uri), options,
	)
	if err := env.WriteFile(dconfKeyfilePath, keyfile, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("wallpaper", err)}
	}

	// A locked key cannot be changed by the person using the machine. Setting
	// a background and forbidding a different one are separate decisions, so
	// the lock file is written only when the policy actually says so.
	locks := ""
	if !s.Wallpaper.AllowUserChange {
		locks = "/org/gnome/desktop/background/picture-uri\n" +
			"/org/gnome/desktop/background/picture-uri-dark\n" +
			"/org/gnome/desktop/background/picture-options\n"
	}
	if err := env.WriteFile(dconfLockPath, locks, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("wallpaper", err)}
	}
	return []policy.Result{runAll(ctx, env, "wallpaper", []string{"dconf", "update"})}
}

// dconf keyfile values are single-quoted GVariant strings.
func dconfEscape(value string) string {
	return strings.NewReplacer("\\", "\\\\", "'", "\\'", "\n", "").Replace(value)
}

// BackgroundDir is where an uploaded picture lands. A background set from a
// policy used to be a URI and nothing else, so a machine that had never been
// given the file by some other means showed the desktop's blank fallback —
// which reads as a broken machine rather than an unset policy.
const BackgroundDir = "/usr/share/backgrounds/odm"

func backgroundURI(uri, image, name string, env Env) (string, error) {
	if image == "" {
		return uri, nil
	}
	raw, err := base64.StdEncoding.DecodeString(image)
	if err != nil {
		return "", fmt.Errorf("background picture: %w", err)
	}
	if name == "" || strings.ContainsAny(name, "/\\") {
		name = "background"
	}
	path := BackgroundDir + "/" + name
	if err := env.WriteFile(path, string(raw), 0o644, "root", "root"); err != nil {
		return "", err
	}
	return "file://" + path, nil
}
