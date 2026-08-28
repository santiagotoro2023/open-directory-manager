package apply

import (
	"context"
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
	if s.Wallpaper == nil || s.Wallpaper.URI == "" {
		return nil
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
		dconfEscape(s.Wallpaper.URI), dconfEscape(s.Wallpaper.URI), options,
	)
	if err := env.WriteFile(dconfKeyfilePath, keyfile, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("wallpaper", err)}
	}

	locks := "/org/gnome/desktop/background/picture-uri\n" +
		"/org/gnome/desktop/background/picture-uri-dark\n" +
		"/org/gnome/desktop/background/picture-options\n"
	if err := env.WriteFile(dconfLockPath, locks, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("wallpaper", err)}
	}
	return []policy.Result{runAll(ctx, env, "wallpaper", []string{"dconf", "update"})}
}

// dconf keyfile values are single-quoted GVariant strings.
func dconfEscape(value string) string {
	return strings.NewReplacer("\\", "\\\\", "'", "\\'", "\n", "").Replace(value)
}
