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
	krb5ConfPath = "/etc/krb5.conf"
	sssdConfPath = "/etc/sssd/sssd.conf"
	// pam_winbind is on a domain-joined Debian whether or not anything asked
	// for it, and it authenticates a domain account perfectly well without
	// ever asking for a Kerberos ticket. A session that came up that way has
	// no ticket at all, and every krb5 mount in it fails with "Required key
	// not available" — the same symptom as a ticket in the wrong place, from
	// a completely different cause.
	winbindPamPath = "/etc/security/pam_winbind.conf"
	ccacheKrb5     = "default_ccache_name = FILE:/tmp/krb5cc_%{uid}"
	ccacheSssd     = "krb5_ccname_template = FILE:/tmp/krb5cc_%U"
	ccacheSetting  = "kerberos:ccache"
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

	// And whichever module ends up authenticating, it has to leave a ticket.
	if err := env.WriteFile(winbindPamPath, Header+`[global]
krb5_auth = yes
krb5_ccache_type = FILE
cached_login = yes
`, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail(ccacheSetting, err)}
	}

	results := []policy.Result{}
	if removed := removeWinbindAuth(ctx, env); removed != nil {
		results = append(results, *removed)
	}

	if !changed {
		return results
	}
	// SSSD decides where it puts a ticket when it opens a session, so it has
	// to read the change before the next one.
	results = append(results, runAll(ctx, env, ccacheSetting,
		[]string{"systemctl", "restart", "sssd"}))
	return append(results, policy.Result{
		Setting: ccacheSetting,
		Status:  "applied",
		Reason: "the ticket now goes where a cifs mount can read it; " +
			"anybody signed in has to sign in again for their drives",
	})
}

// removeWinbindAuth takes pam_winbind out of the authentication stack on a
// machine where SSSD is the one doing the work.
//
// Debian's stack runs pam_unix, then pam_winbind, then pam_sss, and each
// success jumps over the rest. So on a joined desktop pam_winbind answers and
// pam_sss never runs — the account works, the session starts, and there is no
// Kerberos ticket anywhere, because that module was never asked for one and
// SSSD, which was configured to write one, never saw the login. Every drive
// map then fails with "Required key not available".
//
// SSSD is this client's identity and authentication provider; winbind is not
// needed on it at all, and removing the module is what takes it out of the
// stack cleanly — its own removal script rewrites common-auth.
func removeWinbindAuth(ctx context.Context, env Env) *policy.Result {
	raw, err := os.ReadFile(env.Path("/etc/pam.d/common-auth"))
	if err != nil {
		return nil
	}
	stack := string(raw)
	winbind := strings.Index(stack, "pam_winbind.so")
	sss := strings.Index(stack, "pam_sss.so")
	// Only where SSSD is there to take over, and only where winbind is
	// actually in front of it.
	if winbind < 0 || sss < 0 || winbind > sss {
		return nil
	}
	out, err := env.Run.Run(ctx, "apt-get", "remove", "-y", "libpam-winbind")
	if err != nil {
		return &policy.Result{
			Setting: ccacheSetting,
			Status:  "failed",
			Reason: fmt.Sprintf("pam_winbind answers before pam_sss, so no session gets a "+
				"Kerberos ticket, and removing it failed: %v: %s", err, lastLine(out)),
		}
	}
	return &policy.Result{
		Setting: ccacheSetting,
		Status:  "applied",
		Reason: "pam_winbind answered before pam_sss and asked the domain for no ticket; " +
			"removed, so SSSD authenticates and writes one",
	}
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
