package apply

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// What happens when the battery is nearly flat.
//
// This is a machine turning itself off for a reason no timer explains, which
// is why it belongs with the rest of the power settings rather than being
// left to whatever the distribution shipped. UPower decides it, and UPower
// reads exactly one file — there is no drop-in directory to write into, so
// the file the distribution owns is edited in place, one key at a time,
// with everything else in it left alone.
//
// Because it is edited rather than generated, it is never pruned (deleting
// it would take UPower's whole configuration with it) and the original is
// copied aside on the first change, so clearing the setting in the console
// puts the machine back the way the distribution had it instead of leaving
// ODM's last answer behind forever.
const (
	upowerConf     = "/etc/UPower/UPower.conf"
	upowerOriginal = "/var/lib/odm/UPower.conf.original"
)

func applyBatteryCritical(ctx context.Context, power policy.PowerSettings, env Env) []policy.Result {
	if power.CriticalBatteryAction == "" {
		return restoreUPower(ctx, env)
	}
	existing, err := os.ReadFile(env.Path(upowerConf))
	if err != nil {
		// No UPower on this machine — a server, or a desktop without it.
		// Nothing is wrong with the policy, so nothing is failed.
		return []policy.Result{{
			Setting: "power:battery", Status: "skipped",
			Reason: "UPower is not installed on this machine",
		}}
	}

	// The original, once, before the first change. Kept for as long as ODM
	// is managing the file.
	if _, err := os.Stat(env.Path(upowerOriginal)); err != nil {
		if err := env.WriteFile(
			upowerOriginal, string(existing), 0o644, "root", "root",
		); err != nil {
			return []policy.Result{policy.Fail("power:battery", err)}
		}
	} else {
		env.Keep(upowerOriginal)
	}

	updated := setUPowerKeys(string(existing), map[string]string{
		// Percentages, not the time estimate, so the action fires at a level
		// an operator chose rather than at whatever the battery guesses is
		// left in minutes.
		"UsePercentageForPolicy": "true",
		"PercentageAction":       fmt.Sprintf("%d", intOr(power.CriticalBatteryPercent, 2)),
		"CriticalPowerAction":    upowerAction(power.CriticalBatteryAction),
	})
	if updated == string(existing) {
		// Correct already. Still wanted, which is not the same as not
		// written: unclaimed here means deleted on the next pass.
		env.Keep(upowerConf)
		return []policy.Result{{Setting: "power:battery", Status: "success"}}
	}
	if err := env.WriteFile(upowerConf, updated, 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("power:battery", err)}
	}
	return []policy.Result{runAll(ctx, env, "power:battery",
		[]string{"systemctl", "try-restart", "upower"})}
}

// restoreUPower puts the distribution's own file back when the console stops
// setting a critical-battery action, and does nothing at all on a machine
// ODM never touched.
func restoreUPower(ctx context.Context, env Env) []policy.Result {
	original, err := os.ReadFile(env.Path(upowerOriginal))
	if err != nil {
		return nil
	}
	if err := env.WriteFile(upowerConf, string(original), 0o644, "root", "root"); err != nil {
		return []policy.Result{policy.Fail("power:battery", err)}
	}
	if err := os.Remove(env.Path(upowerOriginal)); err != nil && !os.IsNotExist(err) {
		return []policy.Result{policy.Fail("power:battery", err)}
	}
	results := []policy.Result{runAll(ctx, env, "power:battery",
		[]string{"systemctl", "try-restart", "upower"})}
	results[0].Reason = "restored the machine's own UPower configuration"
	return results
}

// setUPowerKeys replaces the value of each key given, wherever in the file it
// already is, and appends the ones that are not there yet under [UPower].
//
// Every occurrence is rewritten rather than only the first: a file with a key
// twice would otherwise depend on which of the two the parser keeps, and a
// guess about somebody else's parser is not something to leave a machine's
// shutdown behaviour resting on.
func setUPowerKeys(content string, values map[string]string) string {
	lines := strings.Split(content, "\n")
	written := map[string]bool{}
	for key, value := range values {
		pattern := regexp.MustCompile(`^\s*#?\s*` + regexp.QuoteMeta(key) + `\s*=`)
		for index, line := range lines {
			if pattern.MatchString(line) {
				lines[index] = key + "=" + value
				written[key] = true
			}
		}
	}

	// Anything the file did not already mention goes under the group that
	// owns it, which is the only group UPower has.
	var missing []string
	for _, key := range sortedKeys(values) {
		if !written[key] {
			missing = append(missing, key+"="+values[key])
		}
	}
	if len(missing) == 0 {
		return strings.Join(lines, "\n")
	}
	for index, line := range lines {
		if strings.TrimSpace(line) == "[UPower]" {
			rest := append([]string{}, lines[index+1:]...)
			lines = append(lines[:index+1], append(missing, rest...)...)
			return strings.Join(lines, "\n")
		}
	}
	return strings.Join(lines, "\n") + "\n[UPower]\n" + strings.Join(missing, "\n") + "\n"
}

// upowerAction is UPower's spelling of the three things it can do. It has no
// "do nothing": the console offers none either, and clearing the setting
// restores the machine's own file instead of asking UPower for a no-op it
// does not have.
func upowerAction(action string) string {
	switch action {
	case "poweroff":
		return "PowerOff"
	case "hibernate":
		return "Hibernate"
	default:
		return "HybridSleep"
	}
}
