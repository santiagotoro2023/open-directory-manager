package apply

import (
	"context"
	"encoding/xml"
	"fmt"
	"strings"

	"odm.example.org/agent/internal/policy"
)

const pamMountPath = "/etc/security/pam_mount.conf.xml"

// Drive maps (CLAUDE.md §3.5, §5.2).
//
// Both flavours mount cifs with sec=krb5, so no credential is ever stored on
// the client — single sign-on rides the user's existing Kerberos ticket.
//
//   - A map with no principal is machine-wide: a systemd .mount plus
//     .automount, so it is mounted on first access rather than at boot.
//   - A map assigned to a user or group is mounted at login by pam_mount,
//     which is the mechanism on Linux for per-user shares.
func applyDriveMaps(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.DriveMaps) == 0 {
		return nil
	}
	var results []policy.Result
	var perUser []policy.DriveMap
	// setting name and unit name, in pairs, enabled once the reload is done.
	var pending []string
	reload := false

	for _, drive := range s.DriveMaps {
		if drive.ForPrincipal != "" {
			perUser = append(perUser, drive)
			continue
		}
		setting := "drive_maps:" + drive.Name
		unitName, err := mountUnitName(ctx, env, drive.MountPoint)
		if err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}

		// //server/share, not the backslash form: a backslash is an escape
		// character in a unit file, and mount.cifs takes either.
		what := strings.ReplaceAll(drive.UNC, "\\", "/")
		options := "sec=krb5,multiuser,_netdev"
		if drive.Options != "" {
			options += "," + drive.Options
		}
		mount := Header + fmt.Sprintf(`[Unit]
Description=ODM drive map %s

[Mount]
What=%s
Where=%s
Type=cifs
Options=%s

[Install]
WantedBy=multi-user.target
`, drive.Name, what, drive.MountPoint, options)

		automount := Header + fmt.Sprintf(`[Unit]
Description=ODM drive map %s (automount)

[Automount]
Where=%s
TimeoutIdleSec=600

[Install]
WantedBy=multi-user.target
`, drive.Name, drive.MountPoint)

		base := "/etc/systemd/system/" + unitName
		if err := env.WriteFile(base+".mount", mount, 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		if err := env.WriteFile(base+".automount", automount, 0o644, "root", "root"); err != nil {
			results = append(results, policy.Fail(setting, err))
			continue
		}
		reload = true
		pending = append(pending, setting, unitName)
	}

	// Reload before enabling, and enable with --now. Without the reload first
	// systemd enables whatever it already had; without --now the automount
	// exists and does not run, so a drive map appeared only after a reboot —
	// and /mnt/shared was simply not there.
	if reload {
		results = append(results, runAll(ctx, env, "drive_maps:reload",
			[]string{"systemctl", "daemon-reload"}))
		for index := 0; index < len(pending); index += 2 {
			results = append(results, runAll(ctx, env, pending[index],
				[]string{"systemctl", "enable", "--now", pending[index+1] + ".automount"},
			))
		}
	}
	if len(perUser) > 0 {
		results = append(results, applyPamMount(perUser, env))
	}
	return results
}

// mountUnitName asks systemd-escape for the unit name, rather than
// reimplementing its escaping rules.
func mountUnitName(ctx context.Context, env Env, mountPoint string) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	out, err := env.Run.Run(ctx, "systemd-escape", "--path", mountPoint)
	if err != nil {
		return "", err
	}
	name := strings.TrimSpace(out)
	if name == "" {
		return "", fmt.Errorf("systemd-escape returned nothing for %q", mountPoint)
	}
	return name, nil
}

type pamMountVolume struct {
	XMLName xml.Name `xml:"volume"`
	User    string   `xml:"user,attr,omitempty"`
	SGRP    string   `xml:"sgrp,attr,omitempty"`
	FSType  string   `xml:"fstype,attr"`
	Server  string   `xml:"server,attr"`
	Path    string   `xml:"path,attr"`
	MountP  string   `xml:"mountpoint,attr"`
	Options string   `xml:"options,attr"`
}

// applyPamMount owns pam_mount.conf.xml outright: it is a single-file format
// with no include mechanism for fragments, so partial ownership is not
// possible. The managed header says so.
func applyPamMount(drives []policy.DriveMap, env Env) policy.Result {
	var volumes strings.Builder
	for _, drive := range drives {
		server, share, ok := splitUNC(drive.UNC)
		if !ok {
			return policy.Fail("drive_maps:pam_mount",
				fmt.Errorf("%s: cannot parse share %q", drive.Name, drive.UNC))
		}
		options := "sec=krb5,cruid=%(USERUID)"
		if drive.Options != "" {
			options += "," + drive.Options
		}
		volume := pamMountVolume{
			FSType: "cifs", Server: server, Path: share,
			MountP: drive.MountPoint, Options: options,
		}
		if strings.HasPrefix(drive.ForPrincipal, "%") {
			volume.SGRP = drive.ForPrincipal[1:]
		} else {
			volume.User = drive.ForPrincipal
		}
		encoded, err := xml.MarshalIndent(volume, "  ", "  ")
		if err != nil {
			return policy.Fail("drive_maps:pam_mount", err)
		}
		volumes.WriteString(string(encoded) + "\n")
	}

	body := `<?xml version="1.0" encoding="utf-8" ?>
<!DOCTYPE pam_mount SYSTEM "pam_mount.conf.xml">
<!-- Managed by Open Directory Manager. Local edits are overwritten. -->
<pam_mount>
  <debug enable="0" />
  <mntoptions allow="nosuid,nodev,sec,cruid,vers,uid,gid,dir_mode,file_mode" />
  <logout wait="0" hup="no" term="no" kill="no" />
  <mkmountpoint enable="1" remove="true" />
` + volumes.String() + `</pam_mount>
`
	if err := env.WriteFile(pamMountPath, body, 0o644, "root", "root"); err != nil {
		return policy.Fail("drive_maps:pam_mount", err)
	}
	return policy.Ok("drive_maps:pam_mount")
}

func splitUNC(unc string) (server, share string, ok bool) {
	trimmed := strings.TrimPrefix(strings.ReplaceAll(unc, "\\", "/"), "//")
	server, share, ok = strings.Cut(trimmed, "/")
	return server, share, ok && server != "" && share != ""
}
