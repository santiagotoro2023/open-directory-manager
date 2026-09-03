package tasks

import (
	"os/exec"
	"strings"
	"testing"
)

// The logon hook has to turn a profile share into the thing to mount and the
// directory to make inside it. mount.cifs takes a share, not a path within
// one, and it will not create a directory that is not there — so getting this
// wrong is a session host where nobody's profile attaches.
//
// Run as shell rather than compared as text: it is shell that ships.
func TestTheLogonHookSplitsAShareFromThePathInsideIt(t *testing.T) {
	script := profileScript()
	const from, to = `SHARE="$(printf`, `case "$SUB" in *..*)`
	start, end := strings.Index(script, from), strings.Index(script, to)
	if start < 0 || end < start {
		t.Fatal("the hook no longer splits the share; update this test with it")
	}
	block := script[start:end]

	for _, want := range []struct{ share, src, sub string }{
		{"//fs01/profiles", "//fs01/profiles", ""},
		{"//fs01/rds-profiles/%username%", "//fs01/rds-profiles", "jdoe"},
		{"//fs01/profiles/teams/%username%", "//fs01/profiles", "teams/jdoe"},
	} {
		out, err := exec.Command("sh", "-c",
			`LOWER_NAME=jdoe; PROFILE_SHARE="`+want.share+`"
`+block+`
printf '%s|%s' "$MOUNT_SRC" "$SUB"`).CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v: %s", want.share, err, out)
		}
		if got := string(out); got != want.src+"|"+want.sub {
			t.Errorf("%s gave %q, wanted %q", want.share, got, want.src+"|"+want.sub)
		}
	}
}
