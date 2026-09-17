package apply

import (
	"context"
	"os"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func TestBlockingRadiosAndCamerasWritesUdevAndModprobeAndLetsTheNamedDeviceThrough(t *testing.T) {
	env, run := testEnv(t)
	settings := policy.Settings{DeviceControl: &policy.DeviceControl{
		Bluetooth: "block", Camera: "block", Microphone: "block", AllowedUSB: []string{"046D:085E"},
	}}
	results := applyDeviceControl(context.Background(), settings, env)
	for _, result := range results {
		if result.Status == "failed" {
			t.Fatalf("%s: %s", result.Setting, result.Reason)
		}
	}
	udev := read(t, env, deviceUdev)
	for _, want := range []string{`ATTRS{idVendor}=="046d", ATTRS{idProduct}=="085e", GOTO="odm_devices_end"`,
		`ATTR{bInterfaceClass}=="e0"`, `ATTR{bInterfaceClass}=="0e"`, `LABEL="odm_devices_end"`} {
		if !strings.Contains(udev, want) {
			t.Errorf("udev rules lack %q:\n%s", want, udev)
		}
	}
	if !strings.Contains(udev, "046d") || strings.Index(udev, "046d") > strings.Index(udev, "bInterfaceClass") {
		t.Error("the allowed device must skip the rules, so it comes first")
	}
	modprobe := read(t, env, deviceModprobe)
	if !strings.Contains(modprobe, "install btusb /bin/false") || !strings.Contains(modprobe, "install uvcvideo /bin/false") {
		t.Errorf("modprobe:\n%s", modprobe)
	}
	if !strings.Contains(read(t, env, deviceWireplumber), "node.disabled = true") {
		t.Error("microphones are not disabled in the sound server")
	}
	if !run.ran("udevadm", "control --reload") || !run.ran("rfkill", "block bluetooth") || !run.ran("modprobe", "-r uvcvideo") {
		t.Errorf("commands: %v", run.commands)
	}

	// Allowed again: the radio is unblocked and the devices re-authorised.
	run.commands = nil
	results = applyDeviceControl(context.Background(), policy.Settings{DeviceControl: &policy.DeviceControl{
		Bluetooth: "allow", Camera: "allow", Microphone: "allow",
	}}, env)
	if !run.ran("rfkill", "unblock bluetooth") || !run.ran("sh", "authorized") {
		t.Errorf("nothing was let back in: %v", run.commands)
	}
	if _, err := readFile(env, deviceUdev); err == nil {
		t.Error("the udev rules should be gone")
	}
}

func readFile(env Env, path string) ([]byte, error) {
	return os.ReadFile(env.Path(path))
}
