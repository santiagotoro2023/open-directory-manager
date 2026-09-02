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

// CreatedPath records what ODM made that is not a file. One record per pass:
// the machine's own, and the one for a person's session.
//
// They must not be shared. Printers and drive maps are user settings, so they
// arrive in a person's document and not in the machine's — and with one
// record between them, the machine's next pass read the queue the login had
// just created, saw no printer in its own policy, and removed it. Every
// fifteen minutes the machine undid the session, which reads as a printer and
// a drive that work at login and are gone later.
const (
	CreatedPath        = "/var/lib/odm/created.json"
	CreatedSessionPath = "/var/lib/odm/created-session.json"
)

type created struct {
	// Which pass wrote this. A record whose scope is not the one asking is
	// not that pass's to act on — which also retires the single shared record
	// earlier versions kept, without one last spurious removal from it.
	Scope     string   `json:"scope,omitempty"`
	Printers  []string `json:"printers,omitempty"`
	DriveMaps []string `json:"drive_maps,omitempty"`
	// Connection files written onto people's desktops, by full path: one
	// person's session must not forget another's.
	RemoteDesktopFiles []string `json:"remote_desktop_files,omitempty"`
}

func createdPath(env Env) string {
	if env.Session {
		return CreatedSessionPath
	}
	return CreatedPath
}

func scopeOf(env Env) string {
	if env.Session {
		return "session"
	}
	return "machine"
}

func loadCreated(env Env) created {
	var state created
	raw, err := os.ReadFile(env.Path(createdPath(env)))
	if err != nil {
		return state
	}
	_ = json.Unmarshal(raw, &state)
	if state.Scope != scopeOf(env) {
		return created{}
	}
	return state
}

func saveCreated(env Env, state created) {
	state.Scope = scopeOf(env)
	sort.Strings(state.Printers)
	sort.Strings(state.DriveMaps)
	sort.Strings(state.RemoteDesktopFiles)
	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return
	}
	path := env.Path(createdPath(env))
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
