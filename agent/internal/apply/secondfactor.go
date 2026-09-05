package apply

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// A second factor at the machine, not only at the console.
//
// pam_oath is Debian's own module for this and asks for the code itself,
// which is the part nothing else in a PAM stack can do — pam_exec runs a
// program but cannot prompt. The codes are the RFC 6238 ones somebody already
// enrolled for the console, so one enrolment covers both and nobody carries
// two.
//
// ponytail: the secrets of the accounts entitled to this machine are on this
// machine, root-only, in the file pam_oath reads. That is the same trust
// boundary as its Kerberos keytab, and it is a real one: a member server
// somebody has root on gives up those secrets. Keeping them on the control
// plane instead needs a PAM module that can prompt and then ask the console,
// which is C nobody here should be writing.

const (
	oathUsersFile   = "/etc/security/users.oath"
	secondFactorPam = "/etc/odm/second-factor.conf"
	// The wrapper PAM runs on a text login, and the autostart entry that
	// does the same thing in a graphical session.
	enrolHelper    = "/usr/lib/odm/enrol-factor"
	enrolAutostart = "/etc/xdg/autostart/odm-enrol-factor.desktop"
)

// Where each way in is decided. A separate file per service, because "at the
// login screen" and "over SSH" are different questions with different answers.
var secondFactorServices = map[string][]string{
	"login":          {"/etc/pam.d/gdm-password", "/etc/pam.d/login"},
	"ssh":            {"/etc/pam.d/sshd"},
	"sudo":           {"/etc/pam.d/sudo"},
	"remote-desktop": {"/etc/pam.d/xrdp-sesman"},
}

// The line itself. requisite rather than required: there is no point asking
// for a password after the second factor has already been refused, and
// "required" would do exactly that.
const oathLine = "auth requisite pam_oath.so usersfile=" + oathUsersFile +
	" window=2 digits=6"

const oathMarker = "pam_oath.so"

// Where the module lives on the two architectures Debian builds for. Checked
// before its name is written into a PAM stack: a stack naming a module that
// is not installed refuses every sign-in through that service, so an agent on
// a machine without it must refuse the setting rather than apply it.
var oathModulePaths = []string{
	"/lib/x86_64-linux-gnu/security/pam_oath.so",
	"/lib/aarch64-linux-gnu/security/pam_oath.so",
	"/usr/lib/x86_64-linux-gnu/security/pam_oath.so",
	"/usr/lib/aarch64-linux-gnu/security/pam_oath.so",
	"/lib/security/pam_oath.so",
	"/usr/lib/security/pam_oath.so",
}

func oathInstalled(env Env) bool {
	for _, path := range oathModulePaths {
		if _, err := os.Stat(env.Path(path)); err == nil {
			return true
		}
	}
	return false
}

// And the session line that walks somebody through setting one up. Optional,
// so a machine that cannot reach the console still lets people in.
const enrolLine = "session optional pam_exec.so " + enrolHelper

const enrolMarker = enrolHelper

func applySecondFactor(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.SecondFactor == nil {
		return nil
	}
	factor := *s.SecondFactor

	if !factor.Enabled {
		// Taken back everywhere it was put, or a policy switched off leaves a
		// machine nobody without a phone can sign in to.
		var results []policy.Result
		for _, paths := range secondFactorServices {
			for _, path := range paths {
				if err := removeOathLine(env, path); err != nil {
					results = append(results, policy.Fail("second_factor", err))
				}
			}
		}
		_ = os.Remove(env.Path(oathUsersFile))
		_ = os.Remove(env.Path(secondFactorPam))
		if err := writeEnrolment(env, false); err != nil {
			results = append(results, policy.Fail("second_factor:enrolment", err))
		}
		if len(results) == 0 {
			results = append(results, policy.Ok("second_factor"))
		}
		return results
	}

	// The module has to be there before its name goes into a PAM stack. It
	// ships with the client package, so this is a machine that predates the
	// setting or one where somebody removed it — either way, writing the line
	// would lock everybody out rather than ask them for a code.
	if !oathInstalled(env) {
		return []policy.Result{{
			Setting: "second_factor",
			Status:  "skipped",
			Reason: "pam_oath is not installed on this machine, and a PAM stack naming a " +
				"module that is not there refuses every sign-in. Install libpam-oath, or " +
				"reinstall the odm-client package, which now depends on it.",
		}}
	}

	// Who it applies to, for the agent's own use when it fetches the
	// enrolments and for an operator reading the machine.
	conf := Header +
		"SERVICES=" + strings.Join(factor.Services, ",") + "\n" +
		"REQUIRE=" + strings.Join(factor.RequirePrincipals, ",") + "\n" +
		"EXEMPT=" + strings.Join(factor.ExemptPrincipals, ",") + "\n" +
		fmt.Sprintf("GRACE_DAYS=%d\n", factor.GraceDays)
	if err := env.WriteFile(secondFactorPam, conf, 0o600, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("second_factor", err)}
	}

	// The users file has to exist before the module reads it, even empty: a
	// missing one makes pam_oath fail every authentication, which locks the
	// machine rather than securing it.
	if _, err := os.Stat(env.Path(oathUsersFile)); os.IsNotExist(err) {
		if err := env.WriteFile(oathUsersFile, "", 0o600, "root", "root"); err != nil {
			return []policy.Result{policy.Fail("second_factor", err)}
		}
	}

	// Setting one up, for somebody who has not. Written whether or not the
	// policy asks for self-enrolment, because turning it off has to take the
	// prompt away as well as stop offering it.
	if err := writeEnrolment(env, factor.SelfEnrol); err != nil {
		return []policy.Result{policy.Fail("second_factor:enrolment", err)}
	}

	var results []policy.Result
	wanted := map[string]bool{}
	for _, service := range factor.Services {
		for _, path := range secondFactorServices[service] {
			wanted[path] = true
		}
	}
	for _, paths := range secondFactorServices {
		for _, path := range paths {
			var err error
			if wanted[path] {
				err = addOathLine(env, path)
			} else {
				err = removeOathLine(env, path)
			}
			if err != nil {
				results = append(results, policy.Fail("second_factor:"+path, err))
			}
		}
	}
	if len(results) == 0 {
		results = append(results, policy.Ok("second_factor"))
	}
	_ = ctx
	return results
}

// WriteOathUsers puts the enrolments this machine is entitled to see into the
// file pam_oath reads. Called by the agent after it has fetched them, not by
// an applier: they are not policy, they are the people the policy names.
func WriteOathUsers(env Env, lines []string) error {
	if len(lines) == 0 {
		// Emptied rather than removed: pam_oath fails every authentication
		// when its file is missing.
		return env.WriteFile(oathUsersFile, "", 0o600, "root", "root")
	}
	sorted := append([]string(nil), lines...)
	sort.Strings(sorted)
	return env.WriteFile(oathUsersFile, strings.Join(sorted, "\n")+"\n", 0o600, "root", "root")
}

// addOathLine puts the module at the top of a PAM stack, where a second
// factor has to be: after the password has been accepted is too late to
// refuse the sign-in.
func addOathLine(env Env, path string) error {
	body, err := os.ReadFile(env.Path(path))
	if err != nil {
		if os.IsNotExist(err) {
			// The service is not installed on this machine — no gdm on a
			// server, no xrdp on a desktop. Not a failure.
			return nil
		}
		return err
	}
	if strings.Contains(string(body), oathMarker) {
		return nil
	}
	managed := "# " + strings.TrimSuffix(strings.TrimPrefix(Header, "# "), "\n") + "\n"
	updated := managed + oathLine + "\n" + string(body)
	// A text login gets the enrolment walkthrough too, at the end of the
	// stack where a session line belongs.
	if enrolOnTty(path) {
		updated = strings.TrimRight(updated, "\n") + "\n" + enrolLine + "\n"
	}
	return os.WriteFile(env.Path(path), []byte(updated), 0o644)
}

// enrolOnTty is where the walkthrough can actually ask a question: a text
// login has a terminal at session open, and a graphical one does not.
func enrolOnTty(path string) bool {
	return strings.HasSuffix(path, "/login") || strings.HasSuffix(path, "/sshd")
}

func removeOathLine(env Env, path string) error {
	body, err := os.ReadFile(env.Path(path))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !strings.Contains(string(body), oathMarker) &&
		!strings.Contains(string(body), enrolMarker) {
		return nil
	}
	var kept []string
	for _, line := range strings.Split(string(body), "\n") {
		if strings.Contains(line, oathMarker) || strings.Contains(line, enrolMarker) {
			continue
		}
		if strings.Contains(line, "Managed by Open Directory Manager") {
			continue
		}
		kept = append(kept, line)
	}
	return os.WriteFile(env.Path(path), []byte(strings.Join(kept, "\n")), 0o644)
}

// writeEnrolment puts the two ways somebody is walked through setting a second
// factor up in place, or takes them away.
//
// Two, because a login screen and a terminal are different things. On a text
// login PAM runs the helper with the terminal the person is sitting at, and
// they are asked there and then. A graphical session has no terminal at that
// point, so the same command is opened in a window as soon as the desktop
// starts — before they can do anything else with it.
func writeEnrolment(env Env, wanted bool) error {
	if !wanted {
		for _, path := range []string{enrolHelper, enrolAutostart} {
			if err := os.Remove(env.Path(path)); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		return nil
	}

	helper := "#!/bin/sh\n" + Header + `
# Ask this person to set up a second factor, if they have not.
#
# Run from PAM at session open on a text login, where standard input is the
# terminal they are sitting at. Never fails the session: somebody who cannot
# finish now is still let in — the grace period is what decides how long that
# stays true, and it is the control plane that decides it.
[ -n "${PAM_USER:-}" ] || exit 0
case "${PAM_TYPE:-}" in close_session) exit 0 ;; esac
[ -t 0 ] || exit 0
/usr/sbin/odm-agent enrol-factor --user "$PAM_USER" </dev/tty >/dev/tty 2>&1 || true
exit 0
`
	if err := env.WriteFile(enrolHelper, helper, 0o755, "root", "root"); err != nil {
		return err
	}

	// x-terminal-emulator is the alternative every Debian desktop provides,
	// so this does not depend on which one is installed.
	entry := "[Desktop Entry]\n" +
		"Type=Application\n" +
		"Name=Set up your second factor\n" +
		"Exec=/bin/sh -c 'command -v x-terminal-emulator >/dev/null && " +
		"exec x-terminal-emulator -e /usr/sbin/odm-agent enrol-factor --user \"$USER\"'\n" +
		"NoDisplay=true\n" +
		"X-GNOME-Autostart-enabled=true\n" +
		"# " + strings.TrimSuffix(strings.TrimPrefix(Header, "# "), "\n") + "\n"
	return env.WriteFile(enrolAutostart, entry, 0o644, "root", "root")
}
