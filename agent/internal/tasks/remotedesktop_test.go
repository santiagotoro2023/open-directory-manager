package tasks

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"odm.example.org/agent/internal/apply"
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

// A name in the access list that this machine cannot look up.
type pickyRunner struct {
	commands [][]string
	unknown  string
}

func (r *pickyRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	r.commands = append(r.commands, append([]string{name}, args...))
	if name == "getent" && len(args) > 1 && args[1] == r.unknown {
		return "", fmt.Errorf("exit status 2")
	}
	return "", nil
}

func TestAnAccessListKeepsTheNamesThisMachineKnows(t *testing.T) {
	// setfacl refuses the whole list when one name in it is unknown, and the
	// list is cleared before it is set — so one name the file server could not
	// resolve left the share with no access list at all.
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc/samba"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "etc/samba/smb.conf"), []byte("[global]\n"), 0o644,
	); err != nil {
		t.Fatal(err)
	}
	runner := &pickyRunner{unknown: "LERN-ST-ODC-99$"}
	env := apply.NewEnv(root)
	env.Run = runner

	out, err := applyShare(context.Background(), map[string]any{
		"name": "rds-profiles", "path": "/srv/shares/rds-profiles",
		"owner": "root", "group": "Domain Admins",
		"acl": []any{
			"g:Engineers:rwx", "d:u:LERN-ST-ODC-01$:rwx", "d:u:LERN-ST-ODC-99$:rwx",
		},
	}, env)
	if err != nil {
		t.Fatalf("applying the share: %v", err)
	}
	if !strings.Contains(out, "LERN-ST-ODC-99$") {
		t.Errorf("the skipped name is not reported: %s", out)
	}

	var set string
	for _, command := range runner.commands {
		if command[0] == "setfacl" && len(command) > 1 && command[1] == "-m" {
			set = command[2]
		}
	}
	for _, want := range []string{"g:Engineers:rwx", "d:u:LERN-ST-ODC-01$:rwx"} {
		if !strings.Contains(set, want) {
			t.Errorf("%q was dropped along with the unknown name: %q", want, set)
		}
	}
	if strings.Contains(set, "ODC-99") {
		t.Errorf("the unknown name was still set: %q", set)
	}
}
