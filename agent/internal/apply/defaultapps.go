package apply

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Which program opens which kind of file.
//
// Two documented mechanisms, both the desktop's own rather than anything ODM
// invents: a MIME package telling the machine what a file extension is, and
// an XDG mimeapps.list saying which desktop entry opens that type. Every
// desktop on Debian reads both — GNOME, XFCE, KDE, and the file managers
// that come with them.
//
// A machine setting, not a user one: a file type that opens one program for
// one person and a different one for the next is a support call, not a
// policy.
const (
	mimePackagePath  = "/usr/share/mime/packages/odm-file-types.xml"
	mimeAppsListPath = "/etc/xdg/mimeapps.list"
	mimeDatabaseDir  = "/usr/share/mime"
)

func applyDefaultApplications(
	ctx context.Context, s policy.Settings, env Env,
) []policy.Result {
	if len(s.DefaultApplications) == 0 {
		return nil
	}
	var results []policy.Result

	// Types the machine does not already know. .rdp is the one that started
	// this: shared-mime-info has never heard of it, so nothing could be the
	// default for something the machine could not name.
	var types strings.Builder
	types.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	types.WriteString("<!-- Managed by Open Directory Manager. Edits here are overwritten. -->\n")
	types.WriteString(`<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">` + "\n")
	globs := 0
	for _, entry := range s.DefaultApplications {
		patterns := extensionsOf(entry.Extensions)
		if len(patterns) == 0 || !safeMimeType(entry.MimeType) {
			continue
		}
		fmt.Fprintf(&types, "  <mime-type type=%q>\n", entry.MimeType)
		fmt.Fprintf(&types, "    <comment>%s</comment>\n", xmlText(entry.MimeType))
		for _, pattern := range patterns {
			fmt.Fprintf(&types, "    <glob pattern=\"*.%s\"/>\n", xmlText(pattern))
		}
		types.WriteString("  </mime-type>\n")
		globs++
	}
	types.WriteString("</mime-info>\n")

	if globs > 0 {
		if err := env.WriteFile(mimePackagePath, types.String(), 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail("default_applications:types", err))
		} else {
			results = append(results, runAll(ctx, env, "default_applications:types",
				[]string{"update-mime-database", mimeDatabaseDir}))
		}
	} else if err := os.Remove(env.Path(mimePackagePath)); err == nil {
		// A policy that stopped registering types takes its file with it, or
		// the machine keeps answering for extensions nothing sets any more.
		results = append(results, runAll(ctx, env, "default_applications:types",
			[]string{"update-mime-database", mimeDatabaseDir}))
	}

	// And which entry opens each. Added as well as default: a type whose only
	// association is the default one is offered by nothing in "Open with".
	var list strings.Builder
	list.WriteString(Header)
	list.WriteString("[Default Applications]\n")
	seen := map[string]string{}
	for _, entry := range s.DefaultApplications {
		if !safeMimeType(entry.MimeType) || !safeDesktopID(entry.Application) {
			results = append(results, policy.Result{
				Setting: "default_applications",
				Status:  "skipped",
				Reason: fmt.Sprintf("%s → %s is not a MIME type and a .desktop entry",
					entry.MimeType, entry.Application),
			})
			continue
		}
		seen[entry.MimeType] = entry.Application
	}
	for _, mime := range sortedKeys(seen) {
		fmt.Fprintf(&list, "%s=%s\n", mime, seen[mime])
	}
	list.WriteString("\n[Added Associations]\n")
	for _, mime := range sortedKeys(seen) {
		fmt.Fprintf(&list, "%s=%s\n", mime, seen[mime])
	}

	if err := env.WriteFile(mimeAppsListPath, list.String(), 0o644, "root", "root"); err != nil {
		results = append(results, policy.Fail("default_applications", err))
	} else {
		results = append(results, policy.Ok("default_applications"))
	}
	return results
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// extensionsOf splits what the console wrote into bare extensions, without
// the dot somebody will type anyway.
func extensionsOf(value string) []string {
	var found []string
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(part), "."))
		if part == "" {
			continue
		}
		if strings.ContainsAny(part, `/\<>"'& `) {
			continue
		}
		found = append(found, part)
	}
	return found
}

// safeMimeType and safeDesktopID are the second pair of eyes on values the
// control plane has already checked. This process is root; it does not have
// to trust what it was handed.
func safeMimeType(value string) bool {
	kind, subtype, found := strings.Cut(value, "/")
	if !found || kind == "" || subtype == "" || len(value) > 128 {
		return false
	}
	return !strings.ContainsAny(value, " \t\n\r<>\"'&=")
}

func safeDesktopID(value string) bool {
	return strings.HasSuffix(value, ".desktop") && len(value) <= 128 &&
		!strings.ContainsAny(value, " \t\n\r/<>\"'&=")
}

// xmlText escapes the two characters that can end an XML element early. The
// values reaching here have already been checked for both; this is what makes
// that a defence in depth rather than the only defence.
func xmlText(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").
		Replace(value)
}
