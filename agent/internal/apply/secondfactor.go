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
	// Run in the person's own session by the autostart entry, as them.
	enrolSession = "/usr/lib/odm/enrol-factor-session"
	// And what that runs as root, because reaching the control plane means
	// reading this machine's keytab, which nobody but root may.
	enrolPrivileged = "/usr/lib/odm/enrol-factor-now"
	enrolSudoers    = "/etc/sudoers.d/odm-enrol-factor"
	// Who has enrolled, by name and nothing else, for the parts of this that
	// run as the person rather than as root. The secrets stay in
	// /etc/security/users.oath, which stays root-only.
	enrolledList = "/var/lib/odm/second-factor-enrolled"
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
		"# Who is asked for a code, and how long somebody who has not enrolled\n" +
		"# has. Readable, because the prompt that walks somebody through\n" +
		"# setting one up runs as them and has to ask the same questions; the\n" +
		"# secrets are in " + oathUsersFile + ", which is root's alone. Written\n" +
		"# root-only, the graphical prompt read nothing and said nothing, and\n" +
		"# a person signing in for the first time was never asked at all.\n" +
		"SERVICES=" + strings.Join(factor.Services, ",") + "\n" +
		"REQUIRE=" + strings.Join(factor.RequirePrincipals, ",") + "\n" +
		"EXEMPT=" + strings.Join(factor.ExemptPrincipals, ",") + "\n" +
		fmt.Sprintf("GRACE_DAYS=%d\n", factor.GraceDays)
	if err := env.WriteFile(secondFactorPam, conf, 0o644, "root", "root"); err != nil {
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
	if err := writeEnrolled(env, lines); err != nil {
		return err
	}
	if len(lines) == 0 {
		// Emptied rather than removed: pam_oath fails every authentication
		// when its file is missing.
		return env.WriteFile(oathUsersFile, "", 0o600, "root", "root")
	}
	sorted := append([]string(nil), lines...)
	sort.Strings(sorted)
	return env.WriteFile(oathUsersFile, strings.Join(sorted, "\n")+"\n", 0o600, "root", "root")
}

// writeEnrolled records who has a second factor, and only that.
//
// The prompt that walks somebody through setting one up runs as them, in
// their own session, and has to know whether to say anything at all. It
// cannot read the file pam_oath reads — that one holds everybody's shared
// secret and is root-only for good reason — so the names are written beside
// it where a person can read them.
func writeEnrolled(env Env, lines []string) error {
	names := make([]string, 0, len(lines))
	for _, line := range lines {
		// HOTP/T30/6 <user> - <secret>
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			names = append(names, fields[1])
		}
	}
	sort.Strings(names)
	body := ""
	if len(names) > 0 {
		body = strings.Join(names, "\n") + "\n"
	}
	return env.WriteFile(enrolledList, body, 0o644, "root", "root")
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
		for _, path := range []string{
			enrolHelper, enrolAutostart, enrolSession, enrolPrivileged, enrolSudoers,
		} {
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

	// What the graphical half runs as root. Reaching the control plane means
	// authenticating as this machine, which means reading its keytab, and
	// that is root's alone — so the session script cannot do this itself.
	// It enrols whoever called it and nobody else: the account comes from
	// sudo, never from an argument, so this cannot be used to set somebody
	// else's second factor.
	privileged := "#!/bin/sh\n" + Header + `
WHO="${SUDO_USER:-}"
[ -n "$WHO" ] || WHO="$(id -un)"

# check: ask the console for this machine's enrolments again and say whether
# this person is now in them. Used by the session prompt to decide whether
# somebody actually finished, rather than trusting that a window was closed.
# Exit 0 enrolled, 1 not, 2 the console could not be reached — which must not
# be read as "not enrolled", or an unreachable console signs people out.
if [ "${1:-}" = "check" ]; then
    SHORT="$(printf '%s' "$WHO" | sed 's/@.*//; s/.*\\\\//' | tr 'A-Z' 'a-z')"
    /usr/sbin/odm-agent apply >/dev/null 2>&1 || exit 2
    [ -r ` + enrolledList + ` ] || exit 2
    grep -qxF "$SHORT" ` + enrolledList + ` && exit 0
    exit 1
fi

exec /usr/sbin/odm-agent enrol-factor --user "$WHO"
`
	if err := env.WriteFile(enrolPrivileged, privileged, 0o755, "root", "root"); err != nil {
		return err
	}
	rule := Header + "ALL ALL=(root) NOPASSWD: " + enrolPrivileged + ", " +
		enrolPrivileged + " check\n"
	if err := env.WriteFile(enrolSudoers, rule, 0o440, "root", "root"); err != nil {
		return err
	}

	// And the half that runs as the person, from their session.
	//
	// A graphical login has no terminal at the point PAM runs, so the text
	// helper above skips it and this is what asks instead — in a terminal
	// window, as soon as the desktop is up and before they can get on with
	// anything else.
	session := "#!/bin/sh\n" + Header + `
# Runs as the person signing in, from /etc/xdg/autostart.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
set -u

WHO="${USER:-$(id -un)}"
[ -n "$WHO" ] || exit 0
[ "$(id -u)" -ge 1000 ] || exit 0
# A local account cannot be given a second factor, so it is never asked for
# one and never walked through setting one up.
getent -s files passwd "$WHO" >/dev/null 2>&1 && exit 0
[ -r ` + secondFactorPam + ` ] || exit 0
. ` + secondFactorPam + `

SHORT="$(printf '%s' "$WHO" | sed 's/@.*//; s/.*\\\\//' | tr 'A-Z' 'a-z')"
GROUPS_OF="$(id -nG 2>/dev/null | tr 'A-Z' 'a-z')"

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

# The same three questions the sign-in guard asks, so nobody is walked
# through setting up something they will never be asked for.
named "${EXEMPT:-}" && exit 0
if [ -n "${REQUIRE:-}" ]; then
    named "$REQUIRE" || exit 0
fi
# Already done: say nothing at all, rather than opening a window every time
# somebody signs in.
if [ -r ` + enrolledList + ` ] && grep -qxF "$SHORT" ` + enrolledList + `; then
    exit 0
fi

# Somebody who has to set one up is asked until they have, and cannot get on
# with anything else first. A window that can be clicked away is a second
# factor nobody sets up: the point of asking here is that the machine is not
# usable until it is done.
open_terminal() {
    for terminal in x-terminal-emulator gnome-terminal kgx konsole xfce4-terminal \
                    mate-terminal xterm; do
        command -v "$terminal" >/dev/null 2>&1 || continue
        case "$terminal" in
            gnome-terminal|mate-terminal)
                "$terminal" --full-screen -- sudo -n ` + enrolPrivileged + ` && return 0
                ;;
            kgx)
                "$terminal" -- sudo -n ` + enrolPrivileged + ` && return 0
                ;;
            konsole|xfce4-terminal)
                "$terminal" --fullscreen -e "sudo -n ` + enrolPrivileged + `" && return 0
                ;;
            *)
                "$terminal" -e sudo -n ` + enrolPrivileged + ` && return 0
                ;;
        esac
    done
    return 1
}

ATTEMPT=1
while [ "$ATTEMPT" -le 3 ]; do
    if ! open_terminal; then
        # No terminal on this desktop, or none that would start. Say what has
        # to happen rather than silently letting somebody past.
        MESSAGE="Set up your second factor: open a terminal and run  sudo ` + enrolPrivileged + `"
        if command -v zenity >/dev/null 2>&1; then
            zenity --error --no-wrap --title="Second factor" --text="$MESSAGE"
        elif command -v notify-send >/dev/null 2>&1; then
            notify-send -u critical "Second factor" "$MESSAGE"
        fi
        exit 0
    fi

    sudo -n ` + enrolPrivileged + ` check
    case "$?" in
        0) exit 0 ;;
        2) exit 0 ;;
    esac
    ATTEMPT=$((ATTEMPT + 1))
done

# Three times round and still not enrolled. The session ends rather than
# carrying on without one: how long somebody may put this off is the grace
# period, and that is the control plane's decision, not this window's.
if command -v zenity >/dev/null 2>&1; then
    zenity --error --no-wrap --title="Second factor" \
        --text="A second factor is required on this machine. Signing out." 2>/dev/null
elif command -v notify-send >/dev/null 2>&1; then
    notify-send -u critical "Second factor" "Required on this machine. Signing out."
fi
sleep 3
loginctl terminate-session "${XDG_SESSION_ID:-}" 2>/dev/null ||
    gnome-session-quit --logout --no-prompt 2>/dev/null ||
    pkill -u "$(id -u)" -x gnome-session-binary 2>/dev/null
exit 0
`
	if err := env.WriteFile(enrolSession, session, 0o755, "root", "root"); err != nil {
		return err
	}

	// The Exec line is parsed by the desktop-entry rules, not by a shell:
	// single quotes are not special there, so a shell command written inline
	// arrived at /bin/sh as its own apostrophes and ran nothing at all. It
	// names a script, which has no quoting to get wrong.
	entry := "[Desktop Entry]\n" +
		"Type=Application\n" +
		"Name=Set up your second factor\n" +
		"Exec=" + enrolSession + "\n" +
		"Terminal=false\n" +
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

# An account in this machine's own files is a local account, whatever its
# user id, and a local account cannot enrol: the control plane only issues a
# second factor to somebody in the directory. Asked for a code they can never
# have, the machine's own administrator would be locked out of it the day the
# grace period ended.
if getent -s files passwd "$USER_NAME" >/dev/null 2>&1; then
    exit 0
fi

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
