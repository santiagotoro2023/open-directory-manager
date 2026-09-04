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

// The desktop is started through Debian's Xsession, which is what sets up
// XDG_CONFIG_DIRS, XDG_DATA_DIRS and the session bus. Started without it,
// xfce4-session cannot find its own defaults under /etc/xdg and every
// connection ends at "Unable to determine failsafe session name".
func TestTheSessionIsStartedThroughXsession(t *testing.T) {
	script := startWM()
	if !strings.Contains(script, "exec /etc/X11/Xsession "+rdSessionScript) {
		t.Errorf("the collection's session is not started through Xsession:\n%s", script)
	}
	if !strings.Contains(script, "exec /etc/X11/Xsession startxfce4") {
		t.Errorf("the plain desktop is not started through Xsession:\n%s", script)
	}
	if strings.Contains(script, "\nexec startxfce4") {
		t.Error("a desktop is still started without a session environment")
	}
}

// A profile disk left mounted after somebody signs out holds the loop device
// and leaves a /home entry that looks like a local account — which is exactly
// what a profile disk exists to avoid.
func TestSigningOutDetachesTheProfileAndTakesTheMountPointWithIt(t *testing.T) {
	script := profileScript()
	for _, want := range []string{
		`umount "$HOME_DIR" 2>/dev/null || umount -l "$HOME_DIR"`,
		`rmdir "$HOME_DIR" 2>/dev/null || true`,
	} {
		if !strings.Contains(script, want) {
			t.Errorf("the close hook is missing %q:\n%s", want, script)
		}
	}
}

// "No profile disk was created" and "this collection was never given a share"
// look identical from the console unless the host says which it was.
func TestTheHookSaysWhyItDidNothing(t *testing.T) {
	script := profileScript()
	if strings.Count(script, "logger -t odm-rd-profile") < 4 {
		t.Errorf("the hook can still exit silently:\n%s", script)
	}
}
