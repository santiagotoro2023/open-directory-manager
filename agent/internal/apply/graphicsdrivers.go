package apply

import (
	"context"
	"fmt"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Graphics drivers (CLAUDE.md §3.5): detecting the card and installing the
// vendor driver it needs, the manual step behind nearly every "why is my
// desktop running the wrong resolution" support call.
//
// Never uninstalled by this applier, unlike almost everything else a policy
// object controls: a working display driver is not something to take back
// automatically the moment a GPO is unlinked or a policy edited, because the
// one machine that would prove the removal was a mistake is the one that can
// no longer show it.
func applyGraphicsDrivers(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.GraphicsDrivers == nil {
		return nil
	}
	mode := s.GraphicsDrivers.Mode
	if mode == "" {
		mode = "auto"
	}
	if mode == "none" {
		return nil
	}

	if mode == "auto" {
		detected, err := detectGraphicsVendor(ctx, env)
		if err != nil {
			return []policy.Result{policy.Fail("graphics_drivers", err)}
		}
		if detected == "" {
			return []policy.Result{{
				Setting: "graphics_drivers", Status: "skipped",
				Reason: "no NVIDIA or AMD graphics card was found (lspci)",
			}}
		}
		mode = detected
	}

	packages, ok := graphicsDriverPackages[mode]
	if !ok {
		return []policy.Result{{
			Setting: "graphics_drivers", Status: "failed",
			Reason: "not a recognised mode: " + mode,
		}}
	}

	results := []policy.Result{runAll(ctx, env, "graphics_drivers:refresh",
		[]string{"apt-get", "update", "-qq"})}
	install := append([]string{"apt-get", "-y", "-o", "Dpkg::Options::=--force-confold",
		"--no-install-recommends", "install"}, packages...)
	result := runAll(ctx, env, "graphics_drivers", install)
	if result.Status == "failed" {
		result.Reason += ". On Debian the NVIDIA driver needs the contrib and " +
			"non-free components enabled in /etc/apt/sources.list — add them and " +
			"apply this policy again."
	} else {
		result.Reason = mode + ": " + strings.Join(packages, ", ")
	}
	results = append(results, result)
	return results
}

// graphicsDriverPackages is what each vendor needs. nvidia-driver pulls in
// the kernel module (through dkms, so it rebuilds itself across kernel
// upgrades), GLX and Vulkan; the AMD packages are firmware and the Mesa
// drivers the kernel's own amdgpu module needs to actually render anything,
// since a card the kernel can drive is not yet one anything can draw with.
var graphicsDriverPackages = map[string][]string{
	"nvidia": {"nvidia-driver", "firmware-misc-nonfree"},
	"amd":    {"firmware-amd-graphics", "mesa-vulkan-drivers", "libgl1-mesa-dri"},
}

// detectGraphicsVendor asks lspci which GPU is in the machine. Returns ""
// rather than an error for "found a card but not one of these two": an
// integrated Intel GPU is a machine this setting has nothing to do for, not
// a failure.
func detectGraphicsVendor(ctx context.Context, env Env) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	out, err := env.Run.Run(ctx, "lspci", "-nnmm")
	if err != nil {
		return "", err
	}
	return graphicsVendorFrom(out), nil
}

// graphicsVendorFrom reads lspci -nnmm's own machine-readable format: one
// quoted field per column, class first. Matched on the PCI vendor ID rather
// than the name text, which lspci is free to render differently depending on
// how current its own hardware database is.
func graphicsVendorFrom(lspci string) string {
	for _, line := range strings.Split(lspci, "\n") {
		fields := splitQuotedFields(line)
		if len(fields) < 3 {
			continue
		}
		class := fields[1]
		if !strings.Contains(class, "VGA") && !strings.Contains(class, "3D") &&
			!strings.Contains(class, "Display") {
			continue
		}
		vendorID := fields[2]
		switch {
		case strings.Contains(vendorID, "[10de]"):
			return "nvidia"
		case strings.Contains(vendorID, "[1002]"):
			return "amd"
		}
	}
	return ""
}

// splitQuotedFields is lspci -mm's own format: fields separated by spaces,
// each wrapped in double quotes, so a vendor name that itself contains a
// space is not mistaken for two fields.
func splitQuotedFields(line string) []string {
	var fields []string
	var current strings.Builder
	inQuotes := false
	for _, r := range line {
		switch {
		case r == '"':
			inQuotes = !inQuotes
		case r == ' ' && !inQuotes:
			if current.Len() > 0 {
				fields = append(fields, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(r)
		}
	}
	if current.Len() > 0 {
		fields = append(fields, current.String())
	}
	return fields
}
