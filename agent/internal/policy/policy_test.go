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
