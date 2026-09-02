package apply

import (
	"context"
	"fmt"
	"os"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Where the ticket goes, which decides whether a drive can be mounted at all.
//
// A cifs mount with sec=krb5 is finished by the kernel, which calls
// cifs.upcall — a process outside the session that finds the ticket by uid,
// not through KRB5CCNAME. Left to the defaults SSSD puts the ticket in the
// kernel keyring or in KCM, where that lookup cannot reach it, and every
// mount fails with "Required key not available" while everything else about
// the session works perfectly.
//
// Domain join writes both settings, but a machine joined by an earlier
// version keeps the configuration it was joined with — and re-joining a
// working machine to fix a mount is not something anybody should have to do.
// So the agent repairs it, in the two files that decide it, and only when it
// wrote them in the first place.
const (
	krb5ConfPath  = "/etc/krb5.conf"
	sssdConfPath  = "/etc/sssd/sssd.conf"
	ccacheKrb5    = "default_ccache_name = FILE:/tmp/krb5cc_%{uid}"
	ccacheSssd    = "krb5_ccname_template = FILE:/tmp/krb5cc_%U"
	ccacheSetting = "kerberos:ccache"
)

func applyCcache(ctx context.Context, _ policy.Settings, env Env) []policy.Result {
	// The session's own pass must not restart the service the session is
	// running on.
	if env.Session || env.Run == nil {
		return nil
	}

	changed := false
	for _, file := range []struct {
		path    string
		setting string
		after   string
		line    string
		mode    os.FileMode
	}{
		{krb5ConfPath, "default_ccache_name", "[libdefaults]", "    " + ccacheKrb5, 0o644},
		{sssdConfPath, "krb5_ccname_template", "[domain/", ccacheSssd, 0o600},
	} {
		added, err := addSetting(env, file.path, file.setting, file.after, file.line, file.mode)
		if err != nil {
			return []policy.Result{policy.Fail(ccacheSetting, err)}
		}
		changed = changed || added
	}

	if !changed {
		return nil
	}
	// SSSD decides where it puts a ticket when it opens a session, so it has
	// to read the change before the next one.
	results := []policy.Result{runAll(ctx, env, ccacheSetting,
		[]string{"systemctl", "restart", "sssd"})}
	return append(results, policy.Result{
		Setting: ccacheSetting,
		Status:  "applied",
		Reason: "the ticket now goes where a cifs mount can read it; " +
			"anybody signed in has to sign in again for their drives",
	})
}

// addSetting puts one line into a file this agent's own join wrote, under the
// section it belongs in. Reports whether it had to.
func addSetting(env Env, path, setting, after, line string, mode os.FileMode) (bool, error) {
	raw, err := os.ReadFile(env.Path(path))
	if err != nil {
		return false, nil // not a machine that has this file: nothing to repair
	}
	body := string(raw)
	if strings.Contains(body, setting) {
		return false, nil
	}
	// Only a file ODM wrote. A hand-written krb5.conf belongs to whoever
	// wrote it, and a machine configured by hand is configured on purpose.
	if !strings.Contains(body, strings.TrimSpace(Header)) {
		return false, nil
	}

	lines := strings.Split(body, "\n")
	for index, text := range lines {
		if !strings.HasPrefix(strings.TrimSpace(text), after) {
			continue
		}
		lines = append(lines[:index+1], append([]string{line}, lines[index+1:]...)...)
		if err := env.WriteFile(path, strings.Join(lines, "\n"), mode,
			"root", "root"); err != nil {
			return false, fmt.Errorf("%s: %w", path, err)
		}
		return true, nil
	}
	return false, nil
}
