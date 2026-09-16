package apply

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"sort"
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
// Chromium's application mode uses the browser's ordinary profile,
// deliberately: the sign-in the person already has is the application's.
// Firefox has no application mode any more, so it is given one: a wrapper
// (webAppLauncher) makes a profile of its own for each application on first
// use, with the tab strip and the toolbar collapsed by userChrome.css and the
// window class set, so it looks and behaves like a program of its own.

const (
	webAppEntries  = "/usr/share/applications"
	webAppIcons    = "/usr/share/icons/hicolor/256x256/apps"
	webAppLauncher = "/usr/lib/odm/webapp"
)

// webAppLauncherScript opens a web application in a Firefox window of its
// own. Run as the person, from the desktop entry: the profile lives in their
// home, made on first use. Tested by running it (apply_test): it is a shell
// script inside a Go string, where a lost $ is invisible to the compiler.
const webAppLauncherScript = `#!/bin/sh
# Managed by Open Directory Manager. Local edits are overwritten.
# Opens a web application in a browser window of its own: odm webapp <slug> <url>
set -e
slug="$1"
url="$2"
[ -n "$slug" ] && [ -n "$url" ] || exit 64
base="${XDG_DATA_HOME:-$HOME/.local/share}/odm-webapps/$slug"
if [ ! -f "$base/user.js" ]; then
  mkdir -p "$base/chrome"
  cat > "$base/user.js" <<'PREFS'
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("browser.tabs.inTitlebar", 0);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("browser.link.open_newwindow", 3);
user_pref("browser.tabs.warnOnClose", false);
PREFS
  cat > "$base/chrome/userChrome.css" <<'CSS'
#TabsToolbar, #nav-bar, #PersonalToolbar, #sidebar-box, #sidebar-splitter { visibility: collapse !important; }
CSS
fi
for browser in firefox firefox-esr; do
  if command -v "$browser" >/dev/null 2>&1; then
    exec "$browser" --no-remote --class "odm-webapp-$slug" --name "odm-webapp-$slug" --profile "$base" --new-window "$url"
  fi
done
echo "no browser found" >&2
exit 69
`

// webAppFetch fetches one URL, following redirects, and says where it ended
// up. Replaced in tests. A browser's user agent, because the sites that
// matter here answer a plain client with a page that names no icons.
var webAppFetch = func(ctx context.Context, location string) (body []byte, contentType, finalURL string, err error) {
	client := &http.Client{Timeout: 20 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return nil, "", "", err
	}
	request.Header.Set("User-Agent",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 odm-agent")
	response, err := client.Do(request)
	if err != nil {
		return nil, "", "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, "", "", fmt.Errorf("%s answered %s", location, response.Status)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	return data, response.Header.Get("Content-Type"), response.Request.URL.String(), err
}

// iconCandidate is one place a site says its icon is, with the size it
// claims for it — the biggest wins, because the launcher's icon is drawn at
// up to 256 pixels and a 16-pixel favicon at that size is what "very low
// resolution" looks like.
type iconCandidate struct {
	href string
	size int
}

var (
	linkTag  = regexp.MustCompile(`(?is)<link\b[^>]*>`)
	attrPair = regexp.MustCompile(`(?is)([a-z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))`)
	sizeSpec = regexp.MustCompile(`(\d+)x(\d+)`)
)

// discoverIcons reads a page for the icons it declares — apple-touch-icon,
// icon with sizes, and the web app manifest's icons — and returns them
// largest first, then the two places a site keeps an icon without saying so.
func discoverIcons(ctx context.Context, pageURL string) []iconCandidate {
	body, _, finalURL, err := webAppFetch(ctx, pageURL)
	base, parseErr := url.Parse(finalURL)
	if err != nil || parseErr != nil {
		base, parseErr = url.Parse(pageURL)
		if parseErr != nil {
			return nil
		}
	}
	var found []iconCandidate
	manifests := []string{}
	for _, tag := range linkTag.FindAllString(string(body), -1) {
		attrs := map[string]string{}
		for _, m := range attrPair.FindAllStringSubmatch(tag, -1) {
			value := m[3] + m[4] + m[5]
			attrs[strings.ToLower(m[1])] = strings.TrimSpace(value)
		}
		rel := strings.ToLower(attrs["rel"])
		href := attrs["href"]
		if href == "" {
			continue
		}
		resolved, err := base.Parse(href)
		if err != nil {
			continue
		}
		switch {
		case strings.Contains(rel, "manifest"):
			manifests = append(manifests, resolved.String())
		case strings.Contains(rel, "apple-touch-icon"):
			size := 180
			if m := sizeSpec.FindStringSubmatch(attrs["sizes"]); m != nil {
				size = atoi(m[1])
			}
			found = append(found, iconCandidate{resolved.String(), size})
		case strings.Contains(rel, "icon"):
			size := 32
			if m := sizeSpec.FindStringSubmatch(attrs["sizes"]); m != nil {
				size = atoi(m[1])
			} else if strings.Contains(attrs["type"], "svg") || strings.HasSuffix(strings.ToLower(resolved.Path), ".svg") {
				size = 512
			}
			found = append(found, iconCandidate{resolved.String(), size})
		}
	}
	for _, location := range manifests {
		raw, _, _, err := webAppFetch(ctx, location)
		if err != nil {
			continue
		}
		var manifest struct {
			Icons []struct {
				Src   string `json:"src"`
				Sizes string `json:"sizes"`
			} `json:"icons"`
		}
		if json.Unmarshal(raw, &manifest) != nil {
			continue
		}
		manifestBase, err := url.Parse(location)
		if err != nil {
			continue
		}
		for _, icon := range manifest.Icons {
			resolved, err := manifestBase.Parse(icon.Src)
			if err != nil {
				continue
			}
			size := 192
			if m := sizeSpec.FindStringSubmatch(icon.Sizes); m != nil {
				size = atoi(m[1])
			}
			found = append(found, iconCandidate{resolved.String(), size})
		}
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].size > found[j].size })
	origin := base.Scheme + "://" + base.Host
	found = append(found,
		iconCandidate{origin + "/apple-touch-icon.png", 180},
		iconCandidate{origin + "/favicon.ico", 16},
	)
	return found
}

func atoi(text string) int {
	n := 0
	for _, r := range text {
		if r < '0' || r > '9' {
			break
		}
		n = n*10 + int(r-'0')
	}
	return n
}

func applyWebApps(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.WebApps) == 0 {
		return nil
	}
	results := make([]policy.Result, 0, len(s.WebApps)+1)
	browser := chooseBrowser(env)
	if err := env.WriteFile(webAppLauncher, webAppLauncherScript, 0o755, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("web_apps", err)}
	}
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
	return webAppLauncher
}

// desktopEntry is the launcher. The URL is quoted as the specification
// quotes an Exec argument; the schema already refused spaces and quotes.
func webAppEntry(app policy.WebApp, slug, browser, icon string) string {
	var exec string
	if browser == "chromium" {
		exec = fmt.Sprintf("%s --app=%s --class=odm-webapp-%s", browserBinary("chromium"), app.URL, slug)
	} else {
		exec = fmt.Sprintf("%s %s %s", webAppLauncher, slug, app.URL)
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
	// The file is named for where the icon came from, so a changed address
	// (or a newer way of finding one) fetches again, and the old file is
	// pruned rather than kept for ever.
	source := app.IconURL
	if source == "" {
		source = "auto:2"
	}
	digest := sha256.Sum256([]byte(source))
	stem := webAppIcons + "/odm-webapp-" + slug + "-" + hex.EncodeToString(digest[:4])
	for _, extension := range []string{".png", ".svg", ".ico"} {
		path := stem + extension
		if _, err := os.Stat(env.Path(path)); err == nil {
			// Fetched on an earlier pass; kept, not re-downloaded.
			env.Keep(path)
			return env.Path(path)
		}
	}
	// An icon the operator uploaded travels inside the policy as a data URL.
	if strings.HasPrefix(app.IconURL, "data:image/") {
		header, payload, ok := strings.Cut(app.IconURL, ",")
		if !ok {
			return ""
		}
		data, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			return ""
		}
		extension := ".png"
		if strings.Contains(header, "svg") {
			extension = ".svg"
		}
		path := stem + extension
		if err := env.WriteFile(path, string(data), 0o644, "root", "root"); err != nil {
			return ""
		}
		return env.Path(path)
	}
	var candidates []iconCandidate
	if app.IconURL != "" {
		candidates = []iconCandidate{{app.IconURL, 256}}
	} else {
		candidates = discoverIcons(ctx, app.URL)
	}
	for _, candidate := range candidates {
		data, contentType, _, err := webAppFetch(ctx, candidate.href)
		if err != nil || len(data) == 0 || strings.Contains(contentType, "text/html") {
			continue
		}
		// What the server says it sent decides the extension; a favicon.ico
		// that is really a PNG (most are) is saved as one.
		extension := ".png"
		lower := strings.ToLower(candidate.href)
		switch {
		case strings.Contains(contentType, "png"):
			extension = ".png"
		case strings.Contains(contentType, "svg") || (contentType == "" && strings.HasSuffix(lower, ".svg")):
			extension = ".svg"
		case strings.Contains(contentType, "icon") || (contentType == "" && strings.HasSuffix(lower, ".ico")):
			extension = ".ico"
		}
		path := stem + extension
		if err := env.WriteFile(path, string(data), 0o644, "root", "root"); err != nil {
			return ""
		}
		return env.Path(path)
	}
	return ""
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
