package apply

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"fmt"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// The graphical boot splash (CLAUDE.md §3.5), on top of the kernel command
// line grub.go writes.
//
// Plymouth is what every mainstream desktop Linux distribution already uses
// for this — a spinner in place of the kernel and initramfs text a boot
// otherwise shows on its way to the login screen — so this installs and
// drives it rather than drawing anything outside Plymouth's own drawing API.
// Its built-in themes cover a spinner, a solid background and a small
// watermark logo, but have no setting for a full custom background picture,
// so a full background is a small theme of this project's own — written
// once, in Plymouth's own Script language, using only long-standing,
// documented primitives every one of Plymouth's own bundled themes is built
// from (Window.SetBackgroundTopColor, Image, Sprite, SetImage, SetX/SetY/
// SetZ, Plymouth.SetRefreshFunction, Plymouth.SetDisplayMessageFunction).
// Nothing in it reaches outside Plymouth's own sandboxed drawing API: no
// file access, no shell, no network from the script itself. The one part of
// this drawn without a real display to check it against — the spin
// animation — is not script logic but a set of pre-rendered frames
// generated once and shipped as plain image assets, the same as the logo or
// background an operator uploads.
const (
	splashPackages = "plymouth plymouth-themes"
	splashTheme    = "odm-boot"
	splashThemeDir = "/usr/share/plymouth/themes/odm-boot"

	splashWatermarkPath  = splashThemeDir + "/watermark.png"
	splashBackgroundPath = splashThemeDir + "/background.png"
	splashAssetSumPath   = "/var/lib/odm/boot-splash-assets.sha256"

	splashMessagePath = "/etc/odm/boot-splash-message.txt"
	splashUnitPath    = "/etc/systemd/system/odm-boot-message.service"
)

//go:embed assets/bootsplash
var splashAssets embed.FS

const splashAssetsRoot = "assets/bootsplash"

// The unit is static and carries no operator-supplied text of its own — the
// message lives in splashMessagePath instead, read through a command
// substitution rather than interpolated into the unit file, so nothing a
// policy sets ever becomes part of a file systemd itself parses as syntax.
// ConditionPathExists means an unset message is "nothing to do" rather than
// a failed unit on every boot of a machine that has never set one.
const splashUnit = Header + `[Unit]
Description=Open Directory Manager boot splash message
After=plymouth-start.service
Before=plymouth-quit-wait.service
ConditionPathExists=` + splashMessagePath + `

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'plymouth display-message --text="$(cat ` + splashMessagePath + `)"'

[Install]
WantedBy=sysinit.target
`

func applyBootSplash(ctx context.Context, g *policy.Grub, env Env) []policy.Result {
	if !g.BootSplash {
		return disableBootSplash(env)
	}
	if env.Run == nil {
		return []policy.Result{policy.Skip("grub:splash", "no command runner")}
	}

	var results []policy.Result
	if !plymouthInstalled(env) {
		if out, err := env.Run.Run(ctx, "apt-get", "update", "-qq"); err != nil {
			return []policy.Result{policy.Fail("grub:splash",
				fmt.Errorf("updating the package index: %w: %s", err, lastLine(out)))}
		}
		args := append([]string{"install", "-y", "--no-install-recommends"}, strings.Fields(splashPackages)...)
		if out, err := env.Run.Run(ctx, "apt-get", args...); err != nil {
			return []policy.Result{policy.Fail("grub:splash",
				fmt.Errorf("installing plymouth: %w: %s", err, lastLine(out)))}
		}
	}

	themeChanged, err := writeSplashTheme(env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", err))
	}
	watermarkChanged, err := applyImageAsset(splashWatermarkPath, g.SplashImage, env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", fmt.Errorf("splash logo: %w", err)))
	}
	backgroundChanged, err := applyImageAsset(splashBackgroundPath, g.SplashBackground, env)
	if err != nil {
		results = append(results, policy.Fail("grub:splash", fmt.Errorf("splash background: %w", err)))
	}

	needsRebuild := !themeIsActive(ctx, env) || themeChanged || watermarkChanged || backgroundChanged
	if needsRebuild {
		// -R rebuilds the initramfs with this theme baked in; without it the
		// theme is set for next time update-initramfs runs for some other
		// reason, and the machine boots on whatever theme it already had.
		if out, err := env.Run.Run(ctx, "plymouth-set-default-theme", splashTheme, "-R"); err != nil {
			results = append(results, policy.Result{
				Setting: "grub:splash", Status: "failed",
				Reason: fmt.Sprintf("setting the boot splash theme: %v: %s", err, lastLine(out)),
			})
		} else {
			results = append(results, policy.Ok("grub:splash"))
		}
	} else {
		results = append(results, policy.Ok("grub:splash"))
	}

	results = append(results, applySplashMessage(ctx, g.SplashMessage, env)...)
	return results
}

// disableBootSplash removes what this machine's own installer would have
// added, on a machine whose policy no longer asks for a splash. Plymouth
// itself is left installed: an operator who turned this off asked for the
// splash to stop, not for a package removed — grub.go already stopped
// writing "quiet splash" onto the kernel command line, which is what
// actually keeps it from showing.
func disableBootSplash(env Env) []policy.Result {
	var results []policy.Result
	if _, err := os.Stat(env.Path(splashMessagePath)); err == nil {
		if err := os.Remove(env.Path(splashMessagePath)); err != nil {
			results = append(results, policy.Fail("grub:splash", err))
		}
	}
	return results
}

// plymouthInstalled reports whether the tool this configures is present,
// checked by path rather than by running it: a machine with no command
// runner still has a filesystem this can look at.
func plymouthInstalled(env Env) bool {
	_, err := os.Stat(env.Path("/usr/sbin/plymouth-set-default-theme"))
	return err == nil
}

// themeIsActive reports whether this machine's default theme is already the
// one this sets, so an unchanged policy does not rebuild the initramfs on
// every refresh — that rebuild is seconds long and not something to pay on
// every fifteen-minute poll for a setting that has not changed.
func themeIsActive(ctx context.Context, env Env) bool {
	out, err := env.Run.Run(ctx, "plymouth-set-default-theme")
	return err == nil && strings.TrimSpace(out) == splashTheme
}

// writeSplashTheme installs this project's own theme — the script, its
// descriptor and the pre-rendered spin frames, all embedded in the agent
// binary — and reports whether any of it actually changed. A signature of
// every embedded file together is what decides that, rather than each
// file's own mtime, so an agent upgrade that changes the script is picked
// up the same way a changed logo is: by rebuilding once, not on every pass.
func writeSplashTheme(env Env) (changed bool, err error) {
	names, err := splashAssetNames()
	if err != nil {
		return false, err
	}

	hash := sha256.New()
	for _, name := range names {
		content, err := splashAssets.ReadFile(path.Join(splashAssetsRoot, name))
		if err != nil {
			return false, fmt.Errorf("reading the bundled %s: %w", name, err)
		}
		hash.Write([]byte(name))
		hash.Write(content)
		if err := env.WriteFile(path.Join(splashThemeDir, name), string(content), 0o644, "root", "root"); err != nil {
			return false, fmt.Errorf("writing %s: %w", name, err)
		}
	}
	sum := fmt.Sprintf("%x", hash.Sum(nil))

	if current, readErr := os.ReadFile(env.Path(splashAssetSumPath)); readErr == nil &&
		strings.TrimSpace(string(current)) == sum {
		return false, nil
	}
	if err := env.WriteFile(splashAssetSumPath, sum+"\n", 0o600, "root", "root"); err != nil {
		return false, fmt.Errorf("recording the theme's signature: %w", err)
	}
	return true, nil
}

// splashAssetNames lists the embedded theme files by name, sorted so the
// combined signature writeSplashTheme hashes them in does not depend on
// filesystem iteration order.
func splashAssetNames() ([]string, error) {
	var names []string
	err := fs.WalkDir(splashAssets, splashAssetsRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			names = append(names, strings.TrimPrefix(p, splashAssetsRoot+"/"))
		}
		return nil
	})
	sort.Strings(names)
	return names, err
}

// applyImageAsset writes or removes one of the two pictures an operator may
// upload — the logo or the background — reporting whether it actually
// changed anything, which is what decides whether the initramfs needs
// rebuilding rather than merely whether a picture was supplied. Shared
// because the logo and the background are the same operation on two
// different files: decode, compare against what is already there, write.
func applyImageAsset(dest, image string, env Env) (changed bool, err error) {
	sumPath := dest + ".sha256"
	if image == "" {
		if _, statErr := os.Stat(env.Path(dest)); statErr != nil {
			return false, nil
		}
		_ = os.Remove(env.Path(dest))
		_ = os.Remove(env.Path(sumPath))
		return true, nil
	}

	raw, decodeErr := base64.StdEncoding.DecodeString(image)
	if decodeErr != nil {
		return false, fmt.Errorf("not valid base64: %w", decodeErr)
	}
	sum := fmt.Sprintf("%x", sha256.Sum256(raw))
	if current, readErr := os.ReadFile(env.Path(sumPath)); readErr == nil &&
		strings.TrimSpace(string(current)) == sum {
		return false, nil
	}
	if err := env.WriteFile(dest, string(raw), 0o644, "root", "root"); err != nil {
		return false, fmt.Errorf("writing %s: %w", dest, err)
	}
	if err := env.WriteFile(sumPath, sum+"\n", 0o600, "root", "root"); err != nil {
		return false, fmt.Errorf("recording %s: %w", dest, err)
	}
	return true, nil
}

// applySplashMessage writes the systemd unit once and keeps the message it
// reads current. The unit itself never changes: only the file it reads at
// boot does, so a message can be added, changed or cleared without a
// daemon-reload or a service restart, and clearing it back to nothing is
// deleting a text file rather than disabling anything.
func applySplashMessage(ctx context.Context, message string, env Env) []policy.Result {
	var results []policy.Result
	if _, err := os.Stat(env.Path(splashUnitPath)); err != nil {
		if err := env.WriteFile(splashUnitPath, splashUnit, 0o644, "root", "root"); err != nil {
			return []policy.Result{policy.Fail("grub:splash_message", err)}
		}
		results = append(results, runAll(ctx, env, "grub:splash_message",
			[]string{"systemctl", "daemon-reload"},
			[]string{"systemctl", "enable", "odm-boot-message.service"},
		))
	}

	if message == "" {
		if _, err := os.Stat(env.Path(splashMessagePath)); err == nil {
			_ = os.Remove(env.Path(splashMessagePath))
		}
		return results
	}
	if err := env.WriteFile(splashMessagePath, message+"\n", 0o644, "root", "root"); err != nil {
		return append(results, policy.Fail("grub:splash_message", err))
	}
	return results
}
