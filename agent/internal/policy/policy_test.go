package policy

import (
	"errors"
	"strings"
	"testing"
)

func TestALongFailureDoesNotSinkTheWholeReport(t *testing.T) {
	// The control plane refuses a reason over 512 characters, and it refuses
	// the report it is in: one applier printing a screenful meant the console
	// showed nothing at all for that run, for any setting.
	long := strings.Repeat("sysctl: permission denied on key kernel.core_pattern\n", 20)
	result := Fail("sysctl", errors.New(long))
	if len(result.Reason) > 512 {
		t.Fatalf("reason is %d characters", len(result.Reason))
	}
	if !strings.Contains(result.Reason, "sysctl: permission denied") {
		t.Error("what went wrong is no longer in it")
	}
	// A short one is left exactly as it was.
	if Fail("x", errors.New("no such file")).Reason != "no such file" {
		t.Error("a short reason was altered")
	}
}

// Fail's own truncation only covers a Result built through Fail. Several
// appliers build one directly — a failed apt install's own dependency trace
// as the reason, in one real case — and those bypassed it entirely: a
// machine that applied every setting correctly still reported nothing,
// because the one over-long reason among its results refused the whole
// report. SanitizeForReport is the guarantee at the one place every report
// actually leaves the machine, so no applier has to remember this itself.
func TestSanitizeForReportCatchesAResultBuiltWithoutFail(t *testing.T) {
	long := strings.Repeat("E: Unable to correct problems, you have held broken packages\n", 20)
	results := []Result{
		{Setting: "packages:install", Status: "failed", Reason: long},
		{Setting: "wallpaper", Status: "success"},
	}

	sanitized := SanitizeForReport(results)

	if len(sanitized[0].Reason) > 512 {
		t.Fatalf("reason is %d characters", len(sanitized[0].Reason))
	}
	if sanitized[1].Reason != "" || sanitized[1].Status != "success" {
		t.Errorf("an untouched result was changed: %+v", sanitized[1])
	}
	// The original slice is left alone: a caller that already reported these
	// results locally, or logged them, must still see what actually happened.
	if len(results[0].Reason) <= 512 {
		t.Error("the original result was mutated")
	}
}

func TestSanitizeForReportAlsoBoundsAnOverLongSettingName(t *testing.T) {
	long := "drive_maps:" + strings.Repeat("x", 400)
	sanitized := SanitizeForReport([]Result{{Setting: long, Status: "failed"}})
	if len(sanitized[0].Setting) > 256 {
		t.Fatalf("setting is %d characters", len(sanitized[0].Setting))
	}
}
