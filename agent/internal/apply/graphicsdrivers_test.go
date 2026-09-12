package apply

import (
	"context"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

// Real `lspci -nnmm` output, captured from an actual machine — an AMD
// platform (vendor 1022) with an NVIDIA discrete GPU (vendor 10de) passed
// through it. This is what graphicsVendorFrom actually has to parse, not a
// hand-typed approximation of it.
const realLspciNvidia = `00:00.0 "Host bridge [0600]" "Advanced Micro Devices, Inc. [AMD] [1022]" "Renoir/Cezanne Root Complex [1630]" -p00 "Advanced Micro Devices, Inc. [AMD] [1022]" "Renoir/Cezanne Root Complex [1630]"
00:14.3 "ISA bridge [0601]" "Advanced Micro Devices, Inc. [AMD] [1022]" "FCH LPC Bridge [790e]" -r51 -p00 "Advanced Micro Devices, Inc. [AMD] [1022]" "Device [d473]"
10:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "GA104 [GeForce RTX 3060 Ti Lite Hash Rate] [2489]" -ra1 -p00 "NVIDIA Corporation [10de]" "GA104 [GeForce RTX 3060 Ti Lite Hash Rate] [2489]"
10:00.1 "Audio device [0403]" "NVIDIA Corporation [10de]" "GA104 High Definition Audio Controller [228b]" -ra1 -p00 "NVIDIA Corporation [10de]" "Device [2489]"
16:00.0 "USB controller [0c03]" "Advanced Micro Devices, Inc. [AMD] [1022]" "500 Series Chipset USB 3.1 XHCI Controller [43ee]" -p30 "ASMedia Technology Inc. [1b21]" "ASM1042A USB 3.0 Host Controller [1142]"
30:00.1 "Audio device [0403]" "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Renoir Radeon High Definition Audio Controller [1637]" -p00 "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Renoir Radeon High Definition Audio Controller [1637]"
`

// The same machine's chipset audio devices carry AMD's platform vendor id
// (1022), not the GPU one (1002, inherited from ATI) — a detector that
// matched on the vendor *name* rather than its id would see "Advanced Micro
// Devices" on the USB controller and chipset audio lines too, several of
// which appear before the GPU itself in lspci's own ordering.
func TestGraphicsVendorIsReadFromRealLspciOutput(t *testing.T) {
	if got := graphicsVendorFrom(realLspciNvidia); got != "nvidia" {
		t.Errorf("got %q, wanted nvidia", got)
	}
}

func TestGraphicsVendorRecognisesAMD(t *testing.T) {
	amd := `01:00.0 "VGA compatible controller [0300]" "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Navi 23 [Radeon RX 6600]" -p00 "" ""`
	if got := graphicsVendorFrom(amd); got != "amd" {
		t.Errorf("got %q, wanted amd", got)
	}
}

// Integrated Intel graphics, or a headless machine with nothing but a
// chipset: not every card is one this setting knows what to do with, and
// that is not the same thing as failing to read lspci at all.
func TestGraphicsVendorIsEmptyForAnUnrecognisedCard(t *testing.T) {
	intel := `00:02.0 "VGA compatible controller [0300]" "Intel Corporation [8086]" "UHD Graphics 630" -p00 "" ""`
	if got := graphicsVendorFrom(intel); got != "" {
		t.Errorf("got %q, wanted none", got)
	}
	if got := graphicsVendorFrom(""); got != "" {
		t.Errorf("empty input produced %q", got)
	}
}

func TestNoDriversSettingDoesNothing(t *testing.T) {
	env, runner := testEnv(t)
	results := applyGraphicsDrivers(context.Background(), policy.Settings{}, env)
	if results != nil {
		t.Errorf("got %+v, wanted nothing", results)
	}
	if len(runner.commands) != 0 {
		t.Errorf("a command ran with no setting at all: %v", runner.commands)
	}
}

func TestModeNoneDoesNothing(t *testing.T) {
	env, runner := testEnv(t)
	results := applyGraphicsDrivers(context.Background(), policy.Settings{
		GraphicsDrivers: &policy.GraphicsDrivers{Mode: "none"},
	}, env)
	if results != nil {
		t.Errorf("got %+v, wanted nothing", results)
	}
	if len(runner.commands) != 0 {
		t.Errorf("a command ran for mode none: %v", runner.commands)
	}
}

func TestAutoDetectsAndInstallsTheNvidiaDriver(t *testing.T) {
	env, runner := testEnv(t)
	runner.output["lspci"] = realLspciNvidia

	results := applyGraphicsDrivers(context.Background(), policy.Settings{
		GraphicsDrivers: &policy.GraphicsDrivers{Mode: "auto"},
	}, env)

	if !runner.ran("apt-get", "nvidia-driver") {
		t.Errorf("nvidia-driver was never installed: %v", runner.commands)
	}
	found := false
	for _, r := range results {
		if r.Setting == "graphics_drivers" {
			found = true
			if r.Status != "success" {
				t.Errorf("status = %q", r.Status)
			}
		}
	}
	if !found {
		t.Errorf("no graphics_drivers result: %+v", results)
	}
}

func TestAutoWithNoRecognisedCardIsSkipped(t *testing.T) {
	env, runner := testEnv(t)
	runner.output["lspci"] = `00:02.0 "VGA compatible controller [0300]" "Intel Corporation [8086]" "UHD Graphics 630" -p00 "" ""`

	results := applyGraphicsDrivers(context.Background(), policy.Settings{
		GraphicsDrivers: &policy.GraphicsDrivers{Mode: "auto"},
	}, env)

	if runner.ran("apt-get", "install") {
		t.Error("a package was installed for a card this does not cover")
	}
	if len(results) != 1 || results[0].Status != "skipped" {
		t.Fatalf("not reported as skipped: %+v", results)
	}
}

// A mode named directly skips detection entirely — for the machine whose
// card lspci cannot identify cleanly, or an operator who simply knows.
func TestAForcedModeSkipsDetection(t *testing.T) {
	env, runner := testEnv(t)

	applyGraphicsDrivers(context.Background(), policy.Settings{
		GraphicsDrivers: &policy.GraphicsDrivers{Mode: "amd"},
	}, env)

	if !runner.ran("lspci", "") {
		// fine: lspci simply should not have been asked at all
	}
	if !runner.ran("apt-get", "firmware-amd-graphics") {
		t.Errorf("the amd packages were never installed: %v", runner.commands)
	}
	for _, command := range runner.commands {
		if command[0] == "lspci" {
			t.Error("a forced mode still ran lspci")
		}
	}
}

// A failed install of the proprietary driver is the one apt failure on this
// machine that is almost always the same known cause, so it is named rather
// than left as apt's own error alone.
func TestAFailedNvidiaInstallNamesTheLikelyCause(t *testing.T) {
	env, runner := testEnv(t)
	runner.fail["apt-get"] = "unable to locate package nvidia-driver"

	results := applyGraphicsDrivers(context.Background(), policy.Settings{
		GraphicsDrivers: &policy.GraphicsDrivers{Mode: "nvidia"},
	}, env)

	var reason string
	for _, r := range results {
		if r.Setting == "graphics_drivers" {
			reason = r.Reason
		}
	}
	if reason == "" || !containsAll(reason, "contrib", "non-free") {
		t.Errorf("the reason does not point at the likely cause: %q", reason)
	}
}

func containsAll(s string, substrings ...string) bool {
	for _, sub := range substrings {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}
