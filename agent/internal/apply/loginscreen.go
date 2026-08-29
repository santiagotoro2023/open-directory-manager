package apply

import (
	"context"
	"fmt"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// The greeter, before anyone has signed in.
//
// GDM reads its own dconf database, separate from the user one, which is why
// this is a machine setting: there is no signed-in user whose policy could
// carry it. The keys are GNOME's documented login-screen settings, not
// anything ODM invents.
const (
	greeterProfilePath = "/etc/dconf/profile/gdm"
	greeterKeyfilePath = "/etc/dconf/db/gdm.d/00-odm-login-screen"
	// A background needs a stylesheet as well as a key: GNOME's greeter takes
	// its image from the shell theme, not from a dconf value.
	greeterCssPath = "/etc/dconf/db/gdm.d/odm-login-background.css"
)

func applyLoginScreen(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.LoginScreen == nil {
		return nil
	}
	screen := *s.LoginScreen

	// GDM's dconf database is its own; without this profile the keys below are
	// written and never read.
	if err := env.WriteFile(
		greeterProfilePath, "user-db:user\nsystem-db:gdm\n", 0o644, "root", "root",
	); err != nil {
		return []policy.Result{policy.Fail("login_screen", err)}
	}

	var keyfile strings.Builder
	keyfile.WriteString(Header)
	keyfile.WriteString("[org/gnome/login-screen]\n")
	// An empty banner is "no banner", which is a setting in its own right: it
	// has to be written, or a banner removed in the console stays on screen.
	fmt.Fprintf(&keyfile, "banner-message-enable=%t\n", screen.BannerText != "")
	if screen.BannerText != "" {
		fmt.Fprintf(&keyfile, "banner-message-text='%s'\n", dconfEscape(screen.BannerText))
	}
	fmt.Fprintf(&keyfile, "disable-user-list=%t\n", screen.DisableUserList)
	if err := env.WriteFile(greeterKeyfilePath, keyfile.String(), 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("login_screen", err)}
	}

	results := []policy.Result{}
	if screen.BackgroundURI != "" {
		fit := screen.BackgroundFit
		if fit == "" {
			fit = "zoom"
		}
		css := fmt.Sprintf(
			"/* Managed by Open Directory Manager. */\n"+
				"#lockDialogGroup {\n"+
				"  background: #1f2937 url(%q);\n"+
				"  background-size: %s;\n"+
				"  background-repeat: no-repeat;\n"+
				"  background-position: center;\n"+
				"}\n",
			strings.TrimPrefix(screen.BackgroundURI, "file://"), cssSize(fit),
		)
		if err := env.WriteFile(greeterCssPath, css, 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail("login_screen:background", err))
		} else {
			results = append(results, policy.Ok("login_screen:background"))
		}
	}

	results = append(results, runAll(ctx, env, "login_screen", []string{"dconf", "update"}))
	return results
}

// cssSize maps the fit an operator chose onto what CSS calls it.
func cssSize(fit string) string {
	switch fit {
	case "centered", "none":
		return "auto"
	case "scaled":
		return "contain"
	case "stretched", "spanned":
		return "100% 100%"
	case "wallpaper":
		return "auto"
	default: // zoom
		return "cover"
	}
}
