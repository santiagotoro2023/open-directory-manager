package apply

import "testing"

// Replacing the agent is the one thing here that cannot be undone remotely: a
// machine given a binary that does not run has no agent to fix it with. So
// the decision to take an update is tested on its own, away from anything
// that touches the disk.
func TestWhatDecidesAnAgentUpdate(t *testing.T) {
	for _, want := range []struct {
		name                           string
		mode, pinned, offered, running string
		take                           bool
	}{
		{"off does nothing at all", "off", "", "0.8.0", "0.7.12", false},
		{"an unwritten mode is off", "", "", "0.8.0", "0.7.12", false},
		{"notify changes nothing", "notify", "", "0.8.0", "0.7.12", false},
		{"install takes a newer one", "install", "", "0.8.0", "0.7.12", true},
		{"install leaves the same one", "install", "", "0.7.12", "0.7.12", false},
		// The whole reason for comparing numbers: as text "0.7.9" sorts after
		// "0.7.12", so a domain would stop updating at the tenth patch.
		{"install does not go backwards", "install", "", "0.7.9", "0.7.12", false},
		{"a pin is taken when the console has it", "install", "0.8.0", "0.8.0", "0.7.12", true},
		{"a pin already met does nothing", "install", "0.8.0", "0.8.0", "0.8.0", false},
		{"a pin the console lacks waits", "install", "0.9.0", "0.8.0", "0.7.12", false},
		// Pinned means pinned: a machine that got ahead comes back.
		{"a pin pulls a machine back", "install", "0.7.12", "0.7.12", "0.8.0", true},
		{"nothing on offer is nothing to do", "install", "", "", "0.7.12", false},
	} {
		t.Run(want.name, func(t *testing.T) {
			take, why := WantsUpdate(want.mode, want.pinned, want.offered, want.running)
			if take != want.take {
				t.Fatalf("take = %v (%q), wanted %v", take, why, want.take)
			}
		})
	}
}

func TestVersionsCompareAsNumbers(t *testing.T) {
	if !Newer("0.7.12", "0.7.9") {
		t.Error("0.7.12 is newer than 0.7.9")
	}
	if Newer("0.7.9", "0.7.12") {
		t.Error("0.7.9 is not newer than 0.7.12")
	}
	if !Newer("1.0.0", "0.99.99") {
		t.Error("a major version wins")
	}
	if Newer("", "0.7.1") {
		t.Error("nothing on offer is never newer")
	}
	if !Newer("0.7.1", "") {
		t.Error("an agent that does not know what it is takes what is offered")
	}
}
