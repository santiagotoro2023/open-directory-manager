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
	env := apply.Env{Root: t.TempDir()}
	script := startWM(env)
	if !strings.Contains(script, "exec /etc/X11/Xsession "+rdSessionScript) {
		t.Errorf("the collection's session is not started through Xsession:\n%s", script)
	}
	if !strings.Contains(script, `exec /etc/X11/Xsession "$session"`) {
		t.Errorf("the plain desktop is not started through Xsession:\n%s", script)
	}
	if strings.Contains(script, "\nexec startxfce4") {
		t.Error("a desktop is still started without a session environment")
	}
}

func TestACollectionServesTheDesktopTheHostWasInstalledWith(t *testing.T) {
	// A GNOME session host put into a collection was told to start XFCE,
	// which was not installed on it: a black screen for a few seconds and
	// then the connection dropped.
	env := apply.Env{Root: t.TempDir()}
	if err := os.MkdirAll(env.Path("/etc/odm"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(env.Path(sessionHostConf), []byte("DESKTOP=gnome\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	script := startWM(env)
	if !strings.Contains(script, "for session in gnome-session ") {
		t.Errorf("a GNOME host is not asked to start GNOME:\n%s", script)
	}
	if !strings.Contains(script, "XDG_CURRENT_DESKTOP=GNOME") {
		t.Errorf("the session does not say which desktop it is:\n%s", script)
	}
	if !strings.Contains(script, "LIBGL_ALWAYS_SOFTWARE") {
		t.Error("a server with no graphics card is not given a renderer")
	}

	// And a host from before the choice existed had XFCE.
	plain := startWM(apply.Env{Root: t.TempDir()})
	if !strings.Contains(plain, "for session in startxfce4 ") {
		t.Errorf("a host with no record is not treated as XFCE:\n%s", plain)
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

// A host being patched is drained rather than removed: removing it would send
// everybody still on it somewhere else at their next reconnect, which is
// exactly what draining exists to avoid.
func TestADrainedHostKeepsItsSessionsAndTakesNoNewOnes(t *testing.T) {
	runner := &recordingRunner{}
	env := apply.NewEnv(t.TempDir())
	env.Run = runner
	if err := os.MkdirAll(env.Path("/etc/haproxy/conf.d"), 0o755); err != nil {
		t.Fatal(err)
	}

	// The configuration is written before haproxy is asked to load it, and
	// nothing is listening in a test, so what is being checked is the file.
	_, _ = applyRemoteDesktopBroker(context.Background(), map[string]any{
		"collection": "Desks",
		"hosts": []any{
			map[string]any{"host": "host1.example.org", "port": float64(3389), "accepts_new": true},
			map[string]any{"host": "host2.example.org", "port": float64(3389), "accepts_new": false},
		},
	}, env)
	config := readFile(t, env, rdBrokerConfig)
	if !strings.Contains(config, "server host2 host2.example.org:3389 check inter 10s weight 0") {
		t.Errorf("the drained host is not drained:\n%s", config)
	}
	if strings.Contains(config, "server host1 host1.example.org:3389 check inter 10s weight 0") {
		t.Errorf("a host that is taking sessions was drained:\n%s", config)
	}
}

// Two brokers keeping one table between them, so somebody reconnecting
// through the standby is still sent to the host holding their session.
func TestTwoBrokersShareOneAffinityTable(t *testing.T) {
	runner := &recordingRunner{}
	env := apply.NewEnv(t.TempDir())
	env.Run = runner
	if err := os.MkdirAll(env.Path("/etc/haproxy/conf.d"), 0o755); err != nil {
		t.Fatal(err)
	}

	_, _ = applyRemoteDesktopBroker(context.Background(), map[string]any{
		"collection": "Desks",
		"hosts":      []any{map[string]any{"host": "host1.example.org", "port": float64(3389)}},
		"brokers":    []any{"rd1.example.org", "rd2.example.org"},
	}, env)
	config := readFile(t, env, rdBrokerConfig)
	for _, want := range []string{
		"peers odm_rd",
		"peer rd1 rd1.example.org:10389",
		"peer rd2 rd2.example.org:10389",
		"peers odm_rd\n    stick on",
	} {
		if !strings.Contains(config, want) {
			t.Errorf("missing %q:\n%s", want, config)
		}
	}

	// One broker keeps its own table; a peers section of one is a section
	// haproxy refuses to start with.
	_, _ = applyRemoteDesktopBroker(context.Background(), map[string]any{
		"collection": "Desks",
		"hosts":      []any{map[string]any{"host": "host1.example.org", "port": float64(3389)}},
		"brokers":    []any{"rd1.example.org"},
	}, env)
	if strings.Contains(readFile(t, env, rdBrokerConfig), "peers odm_rd") {
		t.Error("a single broker was given a peers section")
	}
}

func readFile(t *testing.T, env apply.Env, path string) string {
	t.Helper()
	body, err := os.ReadFile(env.Path(path))
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(body)
}

func TestTheProfileHookRunsBeforeAnythingMakesAHome(t *testing.T) {
	// pam_mkhomedir created and seeded a local home first; the profile disk
	// was mounted over it, and detaching it at sign-out revealed the local
	// copy again — a home directory left on every host for everybody who
	// ever signed in.
	env := apply.Env{Root: t.TempDir()}
	if err := os.MkdirAll(env.Path("/etc/pam.d"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A stack that already carries the line in the place that did not work.
	original := "@include common-auth\n@include common-session\n" +
		"-session optional pam_gnome_keyring.so auto_start\n" +
		"# Managed by Open Directory Manager. Local edits are overwritten.\n" +
		"session required pam_exec.so " + rdProfileScript + "\n"
	if err := os.WriteFile(env.Path(rdPamFile), []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensurePamHook(env); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(env.Path(rdPamFile))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(body), "\n")
	hook, include := -1, -1
	for index, line := range lines {
		if strings.Contains(line, rdProfileScript) {
			if hook >= 0 {
				t.Fatalf("the hook is in there twice:\n%s", body)
			}
			hook = index
		}
		if strings.HasPrefix(strings.TrimSpace(line), "@include common-session") {
			include = index
		}
	}
	if hook < 0 || include < 0 {
		t.Fatalf("the stack lost a line:\n%s", body)
	}
	if hook > include {
		t.Errorf("the profile is attached after a home has been made:\n%s", body)
	}
}
