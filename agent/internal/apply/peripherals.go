package apply

import (
	"context"
	"fmt"
	"os"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Bluetooth, cameras and microphones.
//
// Three refusals, each where it cannot be argued with. A USB device is
// deauthorised by udev the moment it appears, by the class of its interface
// (wireless controller, video), so it is never bound to a driver — and the
// drivers that would carry an internal radio or camera are kept from loading
// at all, then unloaded now. A microphone is refused in the sound server:
// every capture stream starts as an input node there, and disabling those
// leaves playback alone, where refusing the sound card would not. A device
// the policy names by id skips the udev rules, for the approved camera.

const (
	deviceUdev         = "/etc/udev/rules.d/98-odm-devices.rules"
	deviceModprobe     = "/etc/modprobe.d/odm-devices.conf"
	deviceWireplumber  = "/etc/wireplumber/wireplumber.conf.d/50-odm-microphone.conf"
	deviceWireplumber4 = "/etc/wireplumber/main.lua.d/51-odm-microphone.lua"
)

func applyDeviceControl(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	rule := policy.DeviceControl{}
	if s.DeviceControl != nil {
		rule = *s.DeviceControl
	}
	blockBluetooth := rule.Bluetooth == "block"
	blockCamera := rule.Camera == "block"
	blockMicrophone := rule.Microphone == "block"

	// Taken back — the setting gone or everything allowed again: the files
	// leave with the prune, but a device deauthorised by the rule stays
	// deauthorised until it is re-plugged, and a blocked radio stays
	// blocked, unless told otherwise now.
	_, wasBlocking := os.Stat(env.Path(deviceUdev))
	if !blockBluetooth && !blockCamera && wasBlocking == nil && env.Run != nil {
		_, _ = Unsandboxed(ctx, env, "sh", "-c", "for f in /sys/bus/usb/devices/*/authorized; do echo 1 > \"$f\" 2>/dev/null; done")
		_, _ = Unsandboxed(ctx, env, "rfkill", "unblock", "bluetooth")
		_ = os.Remove(env.Path(deviceModprobe))
		_ = os.Remove(env.Path(deviceUdev))
		_, _ = env.Run.Run(ctx, "udevadm", "control", "--reload")
	}
	if s.DeviceControl == nil {
		return nil
	}

	var results []policy.Result
	// udev and modprobe, for the radios and the cameras.
	if blockBluetooth || blockCamera {
		var udev strings.Builder
		udev.WriteString(Header)
		for _, id := range rule.AllowedUSB {
			vendor, product, ok := strings.Cut(strings.ToLower(id), ":")
			if !ok {
				continue
			}
			fmt.Fprintf(&udev, `ATTRS{idVendor}=="%s", ATTRS{idProduct}=="%s", GOTO="odm_devices_end"`+"\n", vendor, product)
		}
		if blockBluetooth {
			// e0/01/01 is a Bluetooth radio's interface; the whole device goes.
			udev.WriteString(`SUBSYSTEM=="usb", ATTR{bInterfaceClass}=="e0", ATTR{bInterfaceSubClass}=="01", ATTR{bInterfaceProtocol}=="01", RUN+="/bin/sh -c 'echo 0 > /sys$devpath/../authorized'"` + "\n")
		}
		if blockCamera {
			// 0e is video; the interface's parent is the device.
			udev.WriteString(`SUBSYSTEM=="usb", ATTR{bInterfaceClass}=="0e", RUN+="/bin/sh -c 'echo 0 > /sys$devpath/../authorized'"` + "\n")
		}
		udev.WriteString(`LABEL="odm_devices_end"` + "\n")
		if err := env.WriteFile(deviceUdev, udev.String(), 0o644, "root", "root"); err != nil {
			return append(results, policy.Fail("device_control", err))
		}
		var modprobe strings.Builder
		modprobe.WriteString(Header)
		if blockBluetooth {
			modprobe.WriteString("install btusb /bin/false\ninstall btintel /bin/false\ninstall bluetooth /bin/false\n")
		}
		if blockCamera {
			modprobe.WriteString("install uvcvideo /bin/false\n")
		}
		if err := env.WriteFile(deviceModprobe, modprobe.String(), 0o644, "root", "root"); err != nil {
			return append(results, policy.Fail("device_control", err))
		}
	}
	if env.Run != nil {
		results = append(results, runAll(ctx, env, "device_control:udev",
			[]string{"udevadm", "control", "--reload"},
			[]string{"udevadm", "trigger", "--subsystem-match=usb", "--action=add"}))
		// Now, not at the next boot. Unloading a module is one of the things
		// the agent's own hardening forbids, hence Unsandboxed (CLAUDE.md).
		if blockBluetooth {
			_, _ = Unsandboxed(ctx, env, "rfkill", "block", "bluetooth")
			_, _ = Unsandboxed(ctx, env, "systemctl", "stop", "bluetooth.service")
			_, _ = Unsandboxed(ctx, env, "modprobe", "-r", "btusb")
		} else {
			_, _ = Unsandboxed(ctx, env, "rfkill", "unblock", "bluetooth")
		}
		if blockCamera {
			_, _ = Unsandboxed(ctx, env, "modprobe", "-r", "uvcvideo")
		}
	}

	// The sound server, for the microphones: one file for WirePlumber 0.5
	// (Debian 13) and one for 0.4 (Debian 12); each version reads its own.
	if blockMicrophone {
		conf := Header +
			"monitor.alsa.rules = [\n" +
			"  {\n" +
			"    matches = [ { node.name = \"~alsa_input.*\" } ]\n" +
			"    actions = { update-props = { node.disabled = true } }\n" +
			"  }\n" +
			"]\n"
		if err := env.WriteFile(deviceWireplumber, conf, 0o644, "root", "root"); err != nil {
			return append(results, policy.Fail("device_control:microphone", err))
		}
		lua := "-- " + strings.TrimSuffix(strings.TrimPrefix(Header, "# "), "\n") + "\n" +
			"table.insert(alsa_monitor.rules, {\n" +
			"  matches = { { { \"node.name\", \"matches\", \"alsa_input.*\" } } },\n" +
			"  apply_properties = { [\"node.disabled\"] = true },\n" +
			"})\n"
		if err := env.WriteFile(deviceWireplumber4, lua, 0o644, "root", "root"); err != nil {
			return append(results, policy.Fail("device_control:microphone", err))
		}
	}
	// WirePlumber runs per session; each is told to reread its
	// configuration, and one that is not running reads it when it starts.
	if env.Run != nil {
		if _, err := os.Stat(env.Path("/run/user")); err == nil {
			_, _ = env.Run.Run(ctx, "sh", "-c",
				"for d in /run/user/*; do u=${d#/run/user/}; systemd-run --quiet --uid=\"$u\" --setenv=XDG_RUNTIME_DIR=\"$d\" --setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=\"$d/bus\" systemctl --user restart wireplumber.service; done")
		}
	}
	results = append(results, policy.Ok("device_control"))
	return results
}
