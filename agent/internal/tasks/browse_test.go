package tasks

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"odm.example.org/agent/internal/apply"
)

func TestABrowseSaysWhoEachThingBelongsToAndWhatTheyMayDoWithIt(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "srv", "shared"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "srv", "note.txt"), []byte("x"), 0o640); err != nil {
		t.Fatal(err)
	}
	env := apply.Env{Root: root}

	out, err := browse(context.Background(), map[string]any{"path": "/srv", "files": true}, env)
	if err != nil {
		t.Fatal(err)
	}
	var answer struct {
		Entries []struct {
			Name  string `json:"name"`
			Owner string `json:"owner"`
			Group string `json:"group"`
			Mode  string `json:"mode"`
		} `json:"entries"`
	}
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		t.Fatal(err)
	}
	if len(answer.Entries) != 2 {
		t.Fatalf("listed %d entries, wanted 2", len(answer.Entries))
	}
	for _, entry := range answer.Entries {
		if entry.Mode == "" || entry.Owner == "" {
			t.Errorf("%s has no ownership: %+v", entry.Name, entry)
		}
	}
	if answer.Entries[0].Mode != "0750" {
		t.Errorf("the directory's mode is %q, wanted 0750", answer.Entries[0].Mode)
	}
}

// Root on the machine runs these, so what reaches chown and chmod is checked
// here as well as by the control plane.
func TestChangingPermissionsRefusesWhatItShouldNeverRun(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{}
	env := apply.Env{Root: root, Run: runner}

	for _, bad := range []map[string]any{
		{"path": "/file"},                            // nothing to change
		{"path": "/", "mode": "0700"},                // never the root
		{"path": "/file", "mode": "7777"},            // not an octal mode
		{"path": "/file", "owner": "root; rm -rf /"}, // not a name
		{"path": "/file", "group": "wheel\nroot"},    // not a name
		{"path": "/nowhere", "mode": "0700"},         // not there
	} {
		if _, err := setPermissions(context.Background(), bad, env); err == nil {
			t.Errorf("%v was accepted", bad)
		}
	}
	if len(runner.commands) != 0 {
		t.Errorf("a rejected change still ran %v", runner.commands)
	}
}

func TestChangingPermissionsRunsChownAndChmodAndAnswersWithTheListing(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "srv", "shared"), 0o755); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{}
	env := apply.Env{Root: root, Run: runner}

	out, err := setPermissions(context.Background(), map[string]any{
		"path": "/srv/shared", "owner": "jdoe", "group": "Domain Users",
		"mode": "0750", "recursive": true,
	}, env)
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.commands) != 2 {
		t.Fatalf("ran %v", runner.commands)
	}
	chown, chmod := runner.commands[0], runner.commands[1]
	if chown[0] != "chown" || chown[1] != "-R" || chown[2] != "jdoe:Domain Users" {
		t.Errorf("chown ran as %v", chown)
	}
	if chmod[0] != "chmod" || chmod[1] != "-R" || chmod[2] != "0750" {
		t.Errorf("chmod ran as %v", chmod)
	}
	// The console shows the result rather than asking for it again.
	var answer struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.Path != "/srv" {
		t.Errorf("answered with %q, wanted the parent listing", answer.Path)
	}
}
