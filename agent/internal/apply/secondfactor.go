package apply

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

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
	// What decides, for this account, whether a code is asked for at all.
	// Without it pam_oath is unconditional, and unconditional means anybody
	// with no enrolment is refused before they are even asked for a password
	// — including root, on every way in at once.
	factorGuard = "/usr/lib/odm/second-factor-required"
	// When the setting first reached this machine, which is what a grace
	// period is counted from. Written once and left alone.
	factorSince = "/var/lib/odm/second-factor-since"
)

// Where each way in is decided. A separate file per service, because "at the
// login screen" and "over SSH" are different questions with different answers.
var secondFactorServices = map[string][]string{
	"login":          {"/etc/pam.d/gdm-password", "/etc/pam.d/login"},
	"ssh":            {"/etc/pam.d/sshd"},
	"sudo":           {"/etc/pam.d/sudo"},
	"remote-desktop": {"/etc/pam.d/xrdp-sesman"},
}

// The two lines, in the order PAM reads them.
//
// The guard runs first and decides whether this account is asked at all: it
// exits 0 to say "not this one", and success=1 jumps over pam_oath. Anything
// else falls through to it. Without the guard pam_oath is unconditional, and
// unconditional refuses everybody who has not enrolled — before the password
// prompt, on every service at once, root included.
//
// requisite on pam_oath rather than required: once the code is wrong there is
// nothing further to ask.
const guardLine = "auth [success=1 default=ignore] pam_exec.so quiet " + factorGuard

const oathLine = "auth requisite pam_oath.so usersfile=" + oathUsersFile +
	" window=2 digits=6"

const oathMarker = "pam_oath.so"

// Where the lines go: after the password has been checked, not before it.
// Asked first, the code is demanded of somebody who then fails the password,
// and the prompt order reads backwards to everybody using it.
const afterPassword = "@include common-auth"

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
	// A setting removed from a policy object arrives here as nothing at all.
	// Returning early on that left the lines on the machine for ever, so
	// taking the setting away was the one thing that could not undo it.
	if s.SecondFactor == nil {
		return removeSecondFactor(env, false)
	}
	factor := *s.SecondFactor

	if !factor.Enabled {
		// Taken back everywhere it was put, or a policy switched off leaves a
		// machine nobody without a phone can sign in to.
		return removeSecondFactor(env, true)
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

	// When this machine first heard of the setting, which is what a grace
	// period counts from. Written once: rewritten on every refresh it would
	// restart the clock every quarter of an hour and the grace would never
	// end.
	if _, err := os.Stat(env.Path(factorSince)); os.IsNotExist(err) {
		_ = os.MkdirAll(filepath.Dir(env.Path(factorSince)), 0o755)
		_ = os.WriteFile(env.Path(factorSince),
			[]byte(fmt.Sprintf("%d\n", time.Now().Unix())), 0o644)
	}

	// Who it applies to. Read by the guard at every sign-in, so what the
	// policy says about grace, "only for" and "except for" is what the
	// machine actually does rather than a description of it.
	conf := Header +
		"SERVICES=" + strings.Join(factor.Services, ",") + "\n" +
		"REQUIRE=" + strings.Join(factor.RequirePrincipals, ",") + "\n" +
		"EXEMPT=" + strings.Join(factor.ExemptPrincipals, ",") + "\n" +
		fmt.Sprintf("GRACE_DAYS=%d\n", factor.GraceDays)
	if err := env.WriteFile(secondFactorPam, conf, 0o600, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("second_factor", err)}
	}

	if err := env.WriteFile(factorGuard, guardScript(), 0o755, "root", "root"); err != nil {
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
	block := managed + guardLine + "\n" + oathLine + "\n"

	// After the password has been checked. Put first, the code is demanded of
	// somebody who then fails the password, and — with nothing in front of it
	// deciding whether to ask at all — of everybody who has not enrolled.
	lines := strings.Split(string(body), "\n")
	inserted := false
	for index, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), afterPassword) {
			lines = append(lines[:index+1],
				append([]string{strings.TrimRight(block, "\n")}, lines[index+1:]...)...)
			inserted = true
			break
		}
	}
	updated := strings.Join(lines, "\n")
	if !inserted {
		// A stack that does not include the common one. The guard still
		// decides, so this is safe wherever it lands.
		updated = block + string(body)
	}
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
		!strings.Contains(string(body), enrolMarker) &&
		!strings.Contains(string(body), factorGuard) {
		return nil
	}
	var kept []string
	for _, line := range strings.Split(string(body), "\n") {
		if strings.Contains(line, oathMarker) || strings.Contains(line, enrolMarker) ||
			strings.Contains(line, factorGuard) {
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

// guardScript decides, for one account at one sign-in, whether a code is
// asked for. It exits 0 to say "not this one", which is the status the PAM
// line jumps over pam_oath on.
//
// Everything it refuses to ask is a decision the policy already made and the
// machine was not reading: the grace period, "only for" and "except for" were
// written into a file and never consulted, so pam_oath asked everybody and
// refused everybody who had not enrolled — before the password prompt, on
// every service at once.
func guardScript() string {
	return "#!/bin/sh\n" + Header + `
# Exit 0: do not ask this account for a code.
# Exit 1: ask.
#
# PAM runs this with almost no environment, and a guard that cannot run must
# not lock anybody out, so every uncertain answer here is "do not ask".
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
set -u

USER_NAME="${PAM_USER:-}"
[ -n "$USER_NAME" ] || exit 0

# Never a local account. root and the machine's own service accounts have to
# keep working, or a machine whose control plane is unreachable is a machine
# nobody can repair.
USER_ID="$(id -u "$USER_NAME" 2>/dev/null || echo 0)"
case "$USER_ID" in ''|*[!0-9]*) exit 0 ;; esac
[ "$USER_ID" -ge 1000 ] || exit 0

[ -r ` + secondFactorPam + ` ] || exit 0
. ` + secondFactorPam + `

SHORT="$(printf '%s' "$USER_NAME" | sed 's/@.*//; s/.*\\\\//' | tr 'A-Z' 'a-z')"
GROUPS_OF="$(id -nG "$USER_NAME" 2>/dev/null | tr 'A-Z' 'a-z')"

# named <list> — whether this account, or a group it is in, is in the list.
named() {
    for entry in $(printf '%s' "$1" | tr ',' ' '); do
        candidate="$(printf '%s' "$entry" | sed 's/^%//' | tr 'A-Z' 'a-z')"
        [ -z "$candidate" ] && continue
        [ "$candidate" = "$SHORT" ] && return 0
        for group in $GROUPS_OF; do
            [ "$candidate" = "$group" ] && return 0
        done
    done
    return 1
}

# Exempt: never asked.
named "${EXEMPT:-}" && exit 0
# Only for: everybody else is not asked.
if [ -n "${REQUIRE:-}" ]; then
    named "$REQUIRE" || exit 0
fi

# Enrolled: asked.
if [ -r ` + oathUsersFile + ` ] && \
        awk -v u="$SHORT" '$2 == u {found=1} END {exit !found}' ` + oathUsersFile + `; then
    exit 1
fi

# Not enrolled. Within the grace period they are let in and walked through
# setting one up; past it they are asked, which pam_oath then refuses — which
# is what a grace period ending means.
GRACE="${GRACE_DAYS:-0}"
[ "$GRACE" -gt 0 ] 2>/dev/null || exit 1
SINCE="$(cat ` + factorSince + ` 2>/dev/null || echo 0)"
case "$SINCE" in ''|*[!0-9]*) exit 1 ;; esac
NOW="$(date +%s)"
if [ "$((NOW - SINCE))" -lt "$((GRACE * 86400))" ]; then
    logger -t odm-second-factor "$SHORT has not enrolled; within the grace period"
    exit 0
fi
exit 1
`
}

// removeSecondFactor takes every line, file and prompt back off the machine.
//
// Reported only when something was actually there: a machine that never had
// the setting should not grow a row in its resultant set for a setting nobody
// configured.
func removeSecondFactor(env Env, configured bool) []policy.Result {
	var results []policy.Result
	removed := false
	for _, paths := range secondFactorServices {
		for _, path := range paths {
			had, err := oathLinePresent(env, path)
			if err == nil && had {
				removed = true
			}
			if err := removeOathLine(env, path); err != nil {
				results = append(results, policy.Fail("second_factor", err))
			}
		}
	}
	for _, path := range []string{oathUsersFile, secondFactorPam, factorGuard} {
		if err := os.Remove(env.Path(path)); err == nil {
			removed = true
		}
	}
	if err := writeEnrolment(env, false); err != nil {
		results = append(results, policy.Fail("second_factor:enrolment", err))
	}
	if len(results) == 0 && (configured || removed) {
		results = append(results, policy.Ok("second_factor"))
	}
	return results
}

func oathLinePresent(env Env, path string) (bool, error) {
	body, err := os.ReadFile(env.Path(path))
	if err != nil {
		return false, err
	}
	return strings.Contains(string(body), oathMarker), nil
}
