package apply

import (
	"context"
	"fmt"
	"os"
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
	// The stylesheet a shell theme can pick the background up from. It is
	// deliberately not under /etc/dconf: everything in a dconf database
	// directory is parsed as a keyfile, and a stylesheet there made "dconf
	// update" fail — taking the banner and the user list down with it.
	greeterCssPath = "/etc/odm/login-background.css"

	// Debian does not compile /etc/dconf/db/gdm.d at all. Its greeter runs
	// with DCONF_PROFILE=Debian-gdm against a database built by
	// /usr/share/gdm/generate-config out of this directory, so a banner
	// written only the upstream way was never read: the keys were right, the
	// database was right, and the login screen showed none of it.
	debianGreeterDir     = "/usr/share/gdm/dconf"
	debianGreeterKeyfile = debianGreeterDir + "/95-odm-login-screen"
	debianGreeterConfig  = "/usr/share/gdm/generate-config"
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

	results := []policy.Result{}
	background, err := backgroundURI(
		screen.BackgroundURI, screen.BackgroundImage, screen.BackgroundImageName, env,
	)
	if err != nil {
		results = append(results, policy.Fail("login_screen:background", err))
	}
	if background != "" {
		fit := screen.BackgroundFit
		if fit == "" {
			fit = "zoom"
		}
		// The greeter session reads the ordinary background keys out of GDM's
		// own database, so the picture is a dconf value like any other rather
		// than something only a rebuilt shell theme could carry.
		fmt.Fprintf(&keyfile, "\n[org/gnome/desktop/background]\n")
		fmt.Fprintf(&keyfile, "picture-uri='%s'\n", dconfEscape(background))
		fmt.Fprintf(&keyfile, "picture-uri-dark='%s'\n", dconfEscape(background))
		fmt.Fprintf(&keyfile, "picture-options='%s'\n", fit)

		// And a stylesheet beside it, for the greeters that take a background
		// from the theme instead. Outside the dconf database, which parses
		// everything in its directory as a keyfile.
		css := fmt.Sprintf(
			"/* Managed by Open Directory Manager. */\n"+
				"#lockDialogGroup {\n"+
				"  background: #1f2937 url(%q);\n"+
				"  background-size: %s;\n"+
				"  background-repeat: no-repeat;\n"+
				"  background-position: center;\n"+
				"}\n",
			strings.TrimPrefix(background, "file://"), cssSize(fit),
		)
		if err := env.WriteFile(greeterCssPath, css, 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail("login_screen:background", err))
		} else {
			results = append(results, greeterBackgroundResult(env))
		}
	}

	if err := env.WriteFile(greeterKeyfilePath, keyfile.String(), 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("login_screen", err)}
	}

	results = append(results, runAll(ctx, env, "login_screen", []string{"dconf", "update"}))

	// And again where Debian's greeter will actually look.
	if _, err := os.Stat(env.Path(debianGreeterDir)); err == nil {
		if err := env.WriteFile(
			debianGreeterKeyfile, keyfile.String(), 0o644, "root", "root",
		); err != nil {
			results = append(results, policy.Fail("login_screen:greeter", err))
		} else {
			results = append(results, runAll(ctx, env, "login_screen:greeter",
				[]string{debianGreeterConfig}))
		}
	}
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

// shellTheme is where GNOME Shell keeps the only stylesheet its greeter reads.
const shellTheme = "/usr/share/gnome-shell/gnome-shell-theme.gresource"

// greeterBackgroundResult says what actually happened to the picture.
//
// GNOME's greeter takes its background from the compiled shell theme and
// ignores the background setting, so on a GNOME machine the picture is
// written, the key is set, and the login screen stays the shell's own grey.
// Reporting that as success would make the console say a setting applied when
// nobody can see it; rebuilding the distribution's theme to force it would put
// a compiler on every desktop and break at the next GNOME update. So it is
// reported for what it is, and the banner and the user list — which do apply —
// are reported separately.
func greeterBackgroundResult(env Env) policy.Result {
	if _, err := os.Stat(env.Path(shellTheme)); err == nil {
		return policy.Result{
			Setting: "login_screen:background",
			Status:  "skipped",
			Reason: "GNOME's greeter takes its background from its compiled shell theme, " +
				"not from a setting. The banner and the user list applied.",
		}
	}
	return policy.Ok("login_screen:background")
}
