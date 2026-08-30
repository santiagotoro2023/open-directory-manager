package apply

import (
	"context"
	"fmt"
	"os"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// What a remote desktop session may carry between the client and the host.
//
// Written into xrdp's own configuration rather than enforced by the agent:
// xrdp is what negotiates these channels, and a rule it does not know about
// is a rule the client can ignore.
const xrdpIniPath = "/etc/xrdp/xrdp.ini"

func applyRemoteDesktopSession(
	ctx context.Context, settings policy.Settings, env Env,
) []policy.Result {
	wanted := settings.RemoteDesktopSession
	if wanted == nil {
		return nil
	}
	path := env.Path(xrdpIniPath)
	body, err := os.ReadFile(path)
	if err != nil {
		// Not a session host. Saying so is more use than failing: the policy
		// object is linked at an OU that holds ordinary machines too.
		return []policy.Result{{
			Setting: "remote_desktop_session",
			Status:  "skipped",
			Reason:  "not a remote desktop session host",
		}}
	}

	depth := wanted.MaxColourDepth
	if depth < 8 || depth > 32 {
		depth = 32
	}
	values := map[string]string{
		"allow_channels": boolIni(anyChannel(wanted)),
		"allow_multimon": "true",
		"max_bpp":        fmt.Sprint(depth),
		"cliprdr":        boolIni(wanted.AllowClipboard),
		"rdpdr":          boolIni(wanted.AllowPrinters || wanted.AllowDrives),
		"rdpsnd":         boolIni(wanted.AllowAudio),
		"drdynvc":        boolIni(wanted.AllowMicrophone || wanted.AllowAudio),
	}

	updated, changed := setIniKeys(string(body), values)
	if changed {
		if err := os.WriteFile(path, []byte(updated), 0o644); err != nil {
			return []policy.Result{policy.Fail("remote_desktop_session", err)}
		}
		if env.Run != nil {
			if _, err := env.Run.Run(ctx, "systemctl", "restart", "xrdp"); err != nil {
				return []policy.Result{policy.Fail("remote_desktop_session", err)}
			}
		}
	}
	env.State.Own(xrdpIniPath)
	return []policy.Result{policy.Ok("remote_desktop_session")}
}

// anyChannel is false only when everything is off, in which case xrdp is told
// to refuse channels outright rather than to offer none of them.
func anyChannel(wanted *policy.RemoteDesktopSession) bool {
	return wanted.AllowClipboard || wanted.AllowPrinters || wanted.AllowDrives ||
		wanted.AllowAudio || wanted.AllowMicrophone
}

func boolIni(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

// setIniKeys rewrites the named keys and leaves every other line alone: the
// rest of xrdp.ini is xrdp's and not ours to have an opinion about.
func setIniKeys(body string, values map[string]string) (string, bool) {
	lines := strings.Split(body, "\n")
	seen := map[string]bool{}
	changed := false
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		for key, value := range values {
			if strings.HasPrefix(trimmed, key+"=") {
				seen[key] = true
				if trimmed != key+"="+value {
					lines[index] = key + "=" + value
					changed = true
				}
			}
		}
	}
	var missing []string
	for key := range values {
		if !seen[key] {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		changed = true
		for _, key := range missing {
			lines = append(lines, key+"="+values[key])
		}
	}
	return strings.Join(lines, "\n"), changed
}
