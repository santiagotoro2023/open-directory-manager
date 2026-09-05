package apply

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Kernel parameters, removable storage, fonts, and which software may be
// installed. Four unrelated settings that share one property: each is a file
// the machine's own tooling already reads, plus the one command that makes it
// take effect.

const (
	sysctlPath      = "/etc/sysctl.d/50-odm.conf"
	removableUdev   = "/etc/udev/rules.d/99-odm-removable.rules"
	removablePolkit = "/etc/polkit-1/rules.d/50-odm-removable.rules"
	fontDir         = "/usr/local/share/fonts/odm"
	aptAllowlist    = "/etc/apt/apt.conf.d/50-odm-software-control"
	aptAllowScript  = "/usr/lib/odm/apt-allowlist"
	aptAllowNames   = "/etc/odm/allowed-software"
	softwarePolkit  = "/etc/polkit-1/rules.d/50-odm-software.rules"
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
		for _, path := range []string{aptAllowlist, aptAllowScript, aptAllowNames, softwarePolkit} {
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
	names := make([]string, 0, len(control.Allowed))
	for _, name := range control.Allowed {
		if safePackageGlob(name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
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

	results := []policy.Result{policy.Ok("software_control")}
	if err := env.WriteFile(
		softwarePolkit, softwarePolkitRule(control), 0o644, "root", "root",
	); err != nil {
		results = append(results, policy.Fail("software_control:desktop", err))
	} else {
		results = append(results, policy.Ok("software_control:desktop"))
	}
	_ = ctx
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
# dpkg hands us one line per package on standard input, after a version
# header and a blank line: "name version-old version-new file". A package
# whose old version is "-" is being installed for the first time; anything
# else is an upgrade, and upgrades are always allowed.

LIST=/etc/odm/allowed-software
[ -r "$LIST" ] || exit 0

# Past the version header.
while read -r line; do
    [ -z "$line" ] && break
done

REFUSED=""
while read -r name old new file; do
    [ -n "$name" ] || continue
    # An upgrade of something already here.
    [ "$old" = "-" ] || continue
    # Configuring a package that is already unpacked, not a new one.
    [ "$new" = "-" ] && continue

    allowed=no
    while IFS= read -r pattern; do
        case "$pattern" in ''|'#'*) continue ;; esac
        case "$pattern" in
            *'*')
                prefix="${pattern%\*}"
                case "$name" in "$prefix"*) allowed=yes ;; esac
                ;;
            *)
                [ "$name" = "$pattern" ] && allowed=yes
                ;;
        esac
        [ "$allowed" = yes ] && break
    done < "$LIST"

    [ "$allowed" = yes ] || REFUSED="$REFUSED $name"
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
