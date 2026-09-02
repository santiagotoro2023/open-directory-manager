package apply

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
)

// Group Policy is declarative: what a policy stops saying, the machine stops
// doing. That is easy for a file — the pruner deletes what is no longer owned
// — and needs a record of its own for anything that is not one. A printer
// queue removed from a policy used to stay on every machine that ever had it,
// and a drive map removed from one stayed mounted with its bookmark still in
// the file manager.

// CreatedPath records what ODM made that is not a file.
const CreatedPath = "/var/lib/odm/created.json"

type created struct {
	Printers  []string `json:"printers,omitempty"`
	DriveMaps []string `json:"drive_maps,omitempty"`
	// Connection files written onto people's desktops, by full path: one
	// person's session must not forget another's.
	RemoteDesktopFiles []string `json:"remote_desktop_files,omitempty"`
}

func loadCreated(env Env) created {
	var state created
	raw, err := os.ReadFile(env.Path(CreatedPath))
	if err != nil {
		return state
	}
	_ = json.Unmarshal(raw, &state)
	return state
}

func saveCreated(env Env, state created) {
	sort.Strings(state.Printers)
	sort.Strings(state.DriveMaps)
	sort.Strings(state.RemoteDesktopFiles)
	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return
	}
	path := env.Path(CreatedPath)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(path, append(body, '\n'), 0o644)
}

// goneFrom returns the entries in was that wanted no longer names.
func goneFrom(was, wanted []string) []string {
	keep := make(map[string]bool, len(wanted))
	for _, name := range wanted {
		keep[name] = true
	}
	var gone []string
	for _, name := range was {
		if !keep[name] {
			gone = append(gone, name)
		}
	}
	return gone
}
