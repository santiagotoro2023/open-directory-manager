package apply

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Kernel parameters, removable storage, fonts, and which software may be
// installed. Four unrelated settings that share one property: each is a file
// the machine's own tooling already reads, plus the one command that makes it
// take effect.

const (
	sysctlPath       = "/etc/sysctl.d/50-odm.conf"
	removableUdev    = "/etc/udev/rules.d/99-odm-removable.rules"
	removablePolkit  = "/etc/polkit-1/rules.d/50-odm-removable.rules"
	fontDir          = "/usr/local/share/fonts/odm"
	aptAllowlist     = "/etc/apt/apt.conf.d/50-odm-software-control"
	aptAllowScript   = "/usr/lib/odm/apt-allowlist"
	aptAllowNames    = "/etc/odm/allowed-software"
	aptAllowResolved = "/etc/odm/allowed-software.resolved"
	softwarePolkit   = "/etc/polkit-1/rules.d/50-odm-software.rules"
)

func applySysctl(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.Sysctl) == 0 {
		return nil
	}
	var body strings.Builder
	body.WriteString(Header)
	seen := map[string]bool{}
	for _, setting := range s.Sysctl {
		if seen[setting.Key] || !safeSysctlKey(setting.Key) || strings.ContainsAny(
			setting.Value, "\n\r") {
			continue
		}
		seen[setting.Key] = true
		fmt.Fprintf(&body, "%s = %s\n", setting.Key, setting.Value)
	}
	if err := env.WriteFile(sysctlPath, body.String(), 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("sysctl", err)}
	}
	// --system rather than -p, so what ends up in force is the machine's whole
	// set in its documented order rather than only this file's.
	return []policy.Result{runAll(ctx, env, "sysctl", []string{"sysctl", "-q", "--system"})}
}

func safeSysctlKey(key string) bool {
	if key == "" || len(key) > 128 || !strings.Contains(key, ".") {
		return false
	}
	for _, r := range key {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-', r == '*':
		default:
			return false
		}
	}
	return true
}

// applyRemovableStorage decides what happens to a disk somebody plugs in.
//
// Through udisks, which is what every desktop file manager mounts with, and
// udev for the read-only case. Not by removing the kernel module: that would
// take the machine's own installer media with it and cannot be made an
// exception to for one group.
//
// ponytail: this stops the desktop mounting it. Somebody who is already root
// on the machine can still mount by hand — that is a sudo rule to look at,
// not something a udisks policy can decide.
func applyRemovableStorage(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.RemovableStorage == nil {
		return nil
	}
	rule := *s.RemovableStorage
	if rule.Mode == "" || rule.Mode == "allow" {
		// Taken back, rather than left behind: a policy that stops blocking
		// has to stop blocking.
		removed := false
		for _, path := range []string{removableUdev, removablePolkit} {
			if err := os.Remove(env.Path(path)); err == nil {
				removed = true
			}
		}
		if !removed {
			return []policy.Result{policy.Ok("removable_storage")}
		}
		return []policy.Result{
			runAll(ctx, env, "removable_storage", []string{"udevadm", "control", "--reload"}),
		}
	}

	var results []policy.Result

	udev := Header
	if rule.Mode == "read_only" {
		// The kernel is told the device is read-only before anything mounts
		// it, so every mount of it is read-only however it is made.
		udev += `SUBSYSTEM=="block", SUBSYSTEMS=="usb", ATTR{ro}="1"` + "\n"
	} else {
		// Hidden from the desktop, which is what udisks reads.
		udev += `SUBSYSTEM=="block", SUBSYSTEMS=="usb", ENV{UDISKS_IGNORE}="1"` + "\n"
	}
	if err := env.WriteFile(removableUdev, udev, 0o644, "root", "root"); err != nil {
		results = append(results, policy.Fail("removable_storage", err))
	}

	if err := env.WriteFile(
		removablePolkit, removablePolkitRule(rule), 0o644, "root", "root",
	); err != nil {
		results = append(results, policy.Fail("removable_storage", err))
	}

	results = append(results,
		runAll(ctx, env, "removable_storage", []string{"udevadm", "control", "--reload"}))
	return results
}

// removablePolkitRule is the JavaScript polkit reads. Every value that
// reaches it is quoted through jsString, because a group name comes from the
// directory and this file runs as a rule on every authorisation decision.
func removablePolkitRule(rule policy.RemovableStorage) string {
	exempt := make([]string, 0, len(rule.ExemptPrincipals))
	for _, principal := range rule.ExemptPrincipals {
		exempt = append(exempt, jsString(strings.TrimPrefix(principal, "%")))
	}
	sort.Strings(exempt)

	action := "polkit.Result.NO"
	if rule.Mode == "read_only" {
		// Mounting is allowed; the device is read-only underneath, so what is
		// refused is anything that would write to it.
		action = "polkit.Result.YES"
	}
	return fmt.Sprintf(`// Managed by Open Directory Manager. Edits here are overwritten.
//
// What may be done with a removable disk. %s
polkit.addRule(function (action, subject) {
    var mount = [
        "org.freedesktop.udisks2.filesystem-mount",
        "org.freedesktop.udisks2.filesystem-mount-system",
        "org.freedesktop.udisks2.filesystem-mount-other-seat"
    ];
    var write = [
        "org.freedesktop.udisks2.filesystem-unmount-others",
        "org.freedesktop.udisks2.modify-device",
        "org.freedesktop.udisks2.open-device"
    ];
    var exempt = [%s];
    for (var i = 0; i < exempt.length; i++) {
        if (subject.user === exempt[i] || subject.isInGroup(exempt[i])) {
            return polkit.Result.YES;
        }
    }
    if (mount.indexOf(action.id) >= 0) {
        return %s;
    }
    if (write.indexOf(action.id) >= 0) {
        return polkit.Result.NO;
    }
});
`, rule.Mode, strings.Join(exempt, ", "), action)
}

// jsString quotes a value for the polkit rule file. Nothing that could end
// the string or the statement survives it.
func jsString(value string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, r := range value {
		switch {
		case r == '"' || r == '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		case r < 0x20 || r == 0x7f:
			// Dropped rather than escaped: nothing legitimate in an account
			// name is a control character.
		default:
			out.WriteRune(r)
		}
	}
	out.WriteByte('"')
	return out.String()
}

// applyFonts installs the fonts the domain provides, and removes the ones it
// has stopped providing.
func applyFonts(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	dir := env.Path(fontDir)
	existing, _ := os.ReadDir(dir)
	if len(s.Fonts) == 0 && len(existing) == 0 {
		return nil
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return []policy.Result{policy.Fail("fonts", err)}
	}
	var results []policy.Result
	wanted := map[string]bool{}
	for _, font := range s.Fonts {
		name := filepath.Base(font.Name)
		if name != font.Name || name == "." || name == ".." {
			results = append(results, policy.Fail("fonts",
				fmt.Errorf("%q is not a file name", font.Name)))
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(font.Content)
		if err != nil {
			results = append(results, policy.Fail("fonts:"+name, err))
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, name), raw, 0o644); err != nil {
			results = append(results, policy.Fail("fonts:"+name, err))
			continue
		}
		wanted[name] = true
	}
	for _, entry := range existing {
		if wanted[entry.Name()] {
			continue
		}
		if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil {
			results = append(results, policy.Fail("fonts", err))
		}
	}
	// Without this the files are on disk and no application can see them.
	results = append(results, runAll(ctx, env, "fonts", []string{"fc-cache", "-f", fontDir}))
	return results
}

// applySoftwareControl refuses to install a package that is not on the list.
//
// A dpkg pre-install hook, which is where apt, aptitude, PackageKit and
// anything else that installs a package on Debian all end up. Upgrading
// something already installed is always allowed, so security updates and the
// packages ODM itself deploys keep working.
func applySoftwareControl(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.SoftwareControl == nil || !s.SoftwareControl.Enabled {
		removed := false
		for _, path := range []string{
			aptAllowlist, aptAllowScript, aptAllowNames, aptAllowResolved, softwarePolkit,
		} {
			if err := os.Remove(env.Path(path)); err == nil {
				removed = true
			}
		}
		if s.SoftwareControl == nil && !removed {
			return nil
		}
		return []policy.Result{policy.Ok("software_control")}
	}
	control := *s.SoftwareControl

	// The list itself, one name per line, so the hook does not have to parse
	// anything and the operator can read what a machine was told.
	names := make([]string, 0, len(control.Allowed)+len(s.Packages))
	for _, name := range control.Allowed {
		if safePackageGlob(name) {
			names = append(names, name)
		}
	}
	// And whatever the policy itself deploys. A domain that says "install
	// this" and "you may not install that" about the same package is a
	// contradiction, and the machine resolved it by refusing — so software
	// deployment stopped working the moment an allowlist was turned on,
	// which is not something an operator would think to connect.
	for _, wanted := range s.Packages {
		if wanted.State != "absent" && safePackageGlob(wanted.Name) {
			names = append(names, wanted.Name)
		}
	}
	sort.Strings(names)
	names = slices.Compact(names)
	if err := env.WriteFile(
		aptAllowNames, Header+strings.Join(names, "\n")+"\n", 0o644, "root", "root",
	); err != nil {
		return []policy.Result{policy.Fail("software_control", err)}
	}

	if err := env.WriteFile(aptAllowScript, allowlistScript(control.Message), 0o755,
		"root", "root"); err != nil {
		return []policy.Result{policy.Fail("software_control", err)}
	}
	// version 2 hands the hook the package name, its old version and its new
	// one on standard input, which is what tells an upgrade from an install.
	conf := Header +
		`DPkg::Pre-Install-Pkgs {"` + aptAllowScript + `";};` + "\n" +
		`DPkg::Tools::options::"` + aptAllowScript + `"::Version "2";` + "\n"
	if err := env.WriteFile(aptAllowlist, conf, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("software_control", err)}
	}

	results := []policy.Result{}
	// What those packages need, so installing one of them actually works.
	if err := resolveAllowed(ctx, env, names); err != nil {
		results = append(results, policy.Result{
			Setting: "software_control:dependencies",
			Status:  "skipped",
			Reason: "what the allowed packages need could not be worked out (" + err.Error() +
				"), so only the names themselves are allowed until the next refresh",
		})
	}
	results = append(results, policy.Ok("software_control"))
	if err := env.WriteFile(
		softwarePolkit, softwarePolkitRule(control), 0o644, "root", "root",
	); err != nil {
		results = append(results, policy.Fail("software_control:desktop", err))
	} else {
		results = append(results, policy.Ok("software_control:desktop"))
	}
	return results
}

func safePackageGlob(name string) bool {
	if name == "" || len(name) > 128 {
		return false
	}
	for index, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9',
			r == '+', r == '.', r == '_', r == '-':
		case r == '*' && index == len(name)-1:
		default:
			return false
		}
	}
	return true
}

// allowlistScript is the hook dpkg runs. Written in shell because it has to
// run before anything else is installed, on a machine that may have nothing
// else on it.
func allowlistScript(message string) string {
	if message == "" {
		message = "Ask your administrator."
	}
	// The message is printed by a shell, inside double quotes. Anything that
	// would change what that means is dropped rather than escaped: a quote, a
	// backslash, a dollar and a backtick are the four that would, and none of
	// them belongs in a sentence telling somebody who to ask.
	message = strings.Map(func(r rune) rune {
		switch r {
		case '"', '\\', '$', '`', '\n', '\r':
			return -1
		}
		return r
	}, message)
	if strings.TrimSpace(message) == "" {
		message = "Ask your administrator."
	}
	return "#!/bin/sh\n" + Header + `
# Refuse a package that is not on this machine's allowed list.
#
# dpkg hands us a block of settings, a blank line, and then one line per
# package in the form
#
#   <name> <old version> <direction> <new version> <file>
#
# where the old version is "-" for something not installed yet, and the file
# is **CONFIGURE** on the second pass over the same packages. Both matter: read
# as four fields the direction is mistaken for the new version, and counting
# the configure pass reports every refused package twice.

LIST=` + aptAllowNames + `
RESOLVED=` + aptAllowResolved + `
[ -r "$LIST" ] || exit 0

# Past the settings block.
while read -r line; do
    [ -z "$line" ] && break
done

# allowed <name> — against the operator's list and the dependencies of what is
# on it. A trailing * matches a prefix.
allowed() {
    for file in "$LIST" "$RESOLVED"; do
        [ -r "$file" ] || continue
        while IFS= read -r pattern; do
            case "$pattern" in ''|'#'*) continue ;; esac
            case "$pattern" in
                *'*')
                    prefix="${pattern%\*}"
                    case "$1" in "$prefix"*) return 0 ;; esac
                    ;;
                *)
                    [ "$1" = "$pattern" ] && return 0
                    ;;
            esac
        done < "$file"
    done
    return 1
}

REFUSED=""
while read -r name old direction new file; do
    [ -n "$name" ] || continue
    # The configure pass is the same packages again.
    [ "$file" = "**CONFIGURE**" ] && continue
    # An upgrade, a downgrade or a reinstall of something already here.
    [ "$old" = "-" ] || continue

    if ! allowed "$name"; then
        case " $REFUSED " in
            *" $name "*) ;;
            *) REFUSED="$REFUSED $name" ;;
        esac
    fi
done

if [ -n "$REFUSED" ]; then
    echo "" >&2
    echo "odm: not on this machine's allowed software list:$REFUSED" >&2
    echo "odm: ` + message + `" >&2
    exit 1
fi
exit 0
`
}

// resolveAllowed writes the packages an allowed one drags in with it.
//
// A list of names alone is a list nothing can be installed from: apt installs
// a package with its dependencies in one transaction, and on a strict list
// every one of those dependencies is a package nobody named. Refusing them
// refuses the package that was actually asked for — which is what made the
// setting look like it simply did not work.
//
// Resolved on the machine, because what a package depends on is a property of
// the release that machine is on rather than of the policy.
func resolveAllowed(ctx context.Context, env Env, names []string) error {
	exact := make([]string, 0, len(names))
	for _, name := range names {
		if !strings.HasSuffix(name, "*") {
			exact = append(exact, name)
		}
	}
	if len(exact) == 0 || env.Run == nil {
		return env.WriteFile(aptAllowResolved, Header, 0o644, "root", "root")
	}

	// Recommends and suggests deliberately left out: they are what a package
	// would like, not what it needs, and pulling them in would widen the list
	// well past what anybody agreed to.
	args := []string{
		"--no-recommends", "--no-suggests", "--no-conflicts", "--no-breaks",
		"--no-replaces", "--no-enhances", "depends", "--recurse",
	}
	out, err := env.Run.Run(ctx, "apt-cache", append(args, exact...)...)
	if err != nil {
		return fmt.Errorf("resolving what the allowed packages need: %w", err)
	}

	found := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		// A dependency is indented; a package being described is not. A name
		// in angle brackets is a virtual package, which nothing installs.
		if line == "" || line[0] == ' ' || line[0] == '|' || line[0] == '<' {
			continue
		}
		name := strings.TrimSpace(line)
		if safePackageGlob(name) {
			found[name] = true
		}
	}
	resolved := make([]string, 0, len(found))
	for name := range found {
		resolved = append(resolved, name)
	}
	sort.Strings(resolved)
	return env.WriteFile(aptAllowResolved,
		Header+"# What the allowed packages need. Worked out on this machine.\n"+
			strings.Join(resolved, "\n")+"\n", 0o644, "root", "root")
}

// softwarePolkitRule stops the desktop's own installers, which do not go
// through apt at all.
func softwarePolkitRule(control policy.SoftwareControl) string {
	blocked := []string{
		"org.freedesktop.packagekit.package-install",
		"org.freedesktop.packagekit.package-install-untrusted",
	}
	if control.BlockFlatpak {
		blocked = append(blocked,
			"org.freedesktop.Flatpak.app-install",
			"org.freedesktop.Flatpak.runtime-install")
	}
	if control.BlockSnap {
		blocked = append(blocked, "io.snapcraft.snapd.manage")
	}
	quoted := make([]string, 0, len(blocked))
	for _, action := range blocked {
		quoted = append(quoted, jsString(action))
	}
	return fmt.Sprintf(`// Managed by Open Directory Manager. Edits here are overwritten.
//
// Installing software from the desktop, which does not go through apt and so
// never reaches the list the package hook checks.
polkit.addRule(function (action, subject) {
    var blocked = [%s];
    if (blocked.indexOf(action.id) >= 0) {
        return polkit.Result.NO;
    }
});
`, strings.Join(quoted, ", "))
}
