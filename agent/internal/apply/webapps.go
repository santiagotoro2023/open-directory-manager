package apply

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	"odm.example.org/agent/internal/policy"
)

// Web applications installed as programs.
//
// What a person gets when they choose "Install as app" in the browser —
// Outlook on the web in a window of its own, with an icon in the grid and
// its own entry in the dock — done for everybody on the machine from a
// policy: a desktop entry that starts the browser in application mode, and
// an icon fetched once from where the policy says (or the site's own
// favicon). Chromium is used where it exists, because its --app mode is the
// real thing; Firefox opens the site in a window of its own otherwise.
//
// The browser's ordinary profile is used, deliberately: the sign-in the
// person already has in the browser is the sign-in the application gets.

const (
	webAppEntries = "/usr/share/applications"
	webAppIcons   = "/usr/share/icons/hicolor/256x256/apps"
)

// webAppFetch fetches an icon. Replaced in tests.
var webAppFetch = func(ctx context.Context, location string) (body []byte, contentType string, err error) {
	client := &http.Client{Timeout: 20 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return nil, "", err
	}
	request.Header.Set("User-Agent", "odm-agent")
	response, err := client.Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("%s answered %s", location, response.Status)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	return data, response.Header.Get("Content-Type"), err
}

func applyWebApps(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.WebApps) == 0 {
		return nil
	}
	results := make([]policy.Result, 0, len(s.WebApps)+1)
	browser := chooseBrowser(env)
	for _, app := range s.WebApps {
		setting := "web_app:" + app.Name
		slug := webAppSlug(app.Name)
		if slug == "" {
			results = append(results, policy.Skip(setting, "the name has no letters or digits to name a file by"))
			continue
		}
		want := app.Browser
		if want == "" || want == "auto" {
			want = browser
		}
		if want == "" {
			results = append(results, policy.Skip(setting, "neither Chromium nor Firefox is installed on this machine"))
			continue
		}
		icon := webAppIcon(ctx, env, slug, app)
		entry := webAppEntry(app, slug, want, icon)
		if err := env.WriteFile(webAppEntries+"/odm-webapp-"+slug+".desktop", entry, 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		results = append(results, policy.Ok(setting))
	}
	if env.Run != nil {
		// Best effort: a desktop that has no cache to update is fine.
		_, _ = env.Run.Run(ctx, "update-desktop-database", env.Path(webAppEntries))
		_, _ = env.Run.Run(ctx, "gtk-update-icon-cache", "-q", "-t", "-f", env.Path("/usr/share/icons/hicolor"))
	}
	return results
}

// chooseBrowser is the one on this machine that draws application windows
// best: Chromium (or Chrome), then Firefox.
func chooseBrowser(env Env) string {
	for _, candidate := range []string{"chromium", "chromium-browser", "google-chrome"} {
		if _, err := exec.LookPath(candidate); err == nil {
			return "chromium"
		}
	}
	if _, err := exec.LookPath("firefox"); err == nil {
		return "firefox"
	}
	if _, err := exec.LookPath("firefox-esr"); err == nil {
		return "firefox"
	}
	return ""
}

func browserBinary(kind string) string {
	if kind == "chromium" {
		for _, candidate := range []string{"chromium", "chromium-browser", "google-chrome"} {
			if _, err := exec.LookPath(candidate); err == nil {
				return candidate
			}
		}
		return "chromium"
	}
	if _, err := exec.LookPath("firefox"); err == nil {
		return "firefox"
	}
	return "firefox-esr"
}

// desktopEntry is the launcher. The URL is quoted as the specification
// quotes an Exec argument; the schema already refused spaces and quotes.
func webAppEntry(app policy.WebApp, slug, browser, icon string) string {
	var exec string
	if browser == "chromium" {
		exec = fmt.Sprintf("%s --app=%s --class=odm-webapp-%s", browserBinary("chromium"), app.URL, slug)
	} else {
		exec = fmt.Sprintf("%s --new-window %s", browserBinary("firefox"), app.URL)
	}
	categories := strings.Join(app.Categories, ";")
	if categories == "" {
		categories = "Network"
	}
	comment := app.Comment
	if comment == "" {
		comment = app.URL
	}
	entry := Header +
		"[Desktop Entry]\n" +
		"Type=Application\n" +
		"Version=1.5\n" +
		"Name=" + app.Name + "\n" +
		"Comment=" + comment + "\n" +
		"Exec=" + exec + "\n" +
		"Terminal=false\n" +
		"Categories=" + categories + ";\n" +
		"StartupNotify=true\n" +
		"StartupWMClass=odm-webapp-" + slug + "\n" +
		"X-ODM-WebApp=" + app.URL + "\n"
	if icon != "" {
		entry += "Icon=" + icon + "\n"
	} else {
		entry += "Icon=web-browser\n"
	}
	return entry
}

// webAppIcon fetches the icon once and returns the path the entry names, or
// "" when there is none to be had. A fetch that fails is not a failed
// setting: the application still opens, under a generic icon, and the next
// apply tries again.
func webAppIcon(ctx context.Context, env Env, slug string, app policy.WebApp) string {
	location := app.IconURL
	if location == "" {
		parsed, err := url.Parse(app.URL)
		if err != nil {
			return ""
		}
		location = parsed.Scheme + "://" + parsed.Host + "/favicon.ico"
	}
	for _, extension := range []string{".png", ".svg", ".ico"} {
		path := webAppIcons + "/odm-webapp-" + slug + extension
		if _, err := os.Stat(env.Path(path)); err == nil {
			// Fetched on an earlier pass; kept, not re-downloaded.
			env.Keep(path)
			return env.Path(path)
		}
	}
	data, contentType, err := webAppFetch(ctx, location)
	if err != nil || len(data) == 0 {
		return ""
	}
	// What the server says it sent decides the extension; a favicon.ico
	// that is really a PNG (most are) is saved as one.
	extension := ".png"
	lower := strings.ToLower(location)
	switch {
	case strings.Contains(contentType, "png"):
		extension = ".png"
	case strings.Contains(contentType, "svg") || (contentType == "" && strings.HasSuffix(lower, ".svg")):
		extension = ".svg"
	case strings.Contains(contentType, "icon") || (contentType == "" && strings.HasSuffix(lower, ".ico")):
		extension = ".ico"
	}
	path := webAppIcons + "/odm-webapp-" + slug + extension
	if err := env.WriteFile(path, string(data), 0o644, "root", "root"); err != nil {
		return ""
	}
	return env.Path(path)
}

// webAppSlug is the file-name form of a name: letters and digits, lower
// case, dashes between.
func webAppSlug(name string) string {
	var out strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			out.WriteRune(r)
			dash = false
		default:
			if out.Len() > 0 && !dash {
				out.WriteByte('-')
				dash = true
			}
		}
	}
	return strings.TrimRight(out.String(), "-")
}
