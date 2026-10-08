package join

import (
	"strings"
	"testing"
)

func TestKeepHostnameKeepsAShortNameThatIsTheDomainNamesOwn(t *testing.T) {
	name := MachineName{Current: "srv1", Wanted: "srv1.corp.example.internal", Short: "srv1"}
	rename, err := hostnameAction(name, Options{Domain: "corp.example.internal", KeepName: true})
	if err != nil || rename {
		t.Fatalf("kept short name: rename=%v err=%v, want neither", rename, err)
	}
}

func TestKeepHostnameStillRefusesADifferentName(t *testing.T) {
	name := MachineName{Current: "worker7", Wanted: "srv1.corp.example.internal", Short: "srv1"}
	_, err := hostnameAction(name, Options{Domain: "corp.example.internal", KeepName: true})
	if err == nil || !strings.Contains(err.Error(), "drop --keep-hostname") {
		t.Fatalf("a name that is not the domain name's was accepted: %v", err)
	}
}

func TestWithoutKeepHostnameAShortNameIsRenamed(t *testing.T) {
	name := MachineName{Current: "srv1", Wanted: "srv1.corp.example.internal", Short: "srv1"}
	rename, err := hostnameAction(name, Options{Domain: "corp.example.internal"})
	if err != nil || !rename {
		t.Fatalf("rename=%v err=%v, want a rename", rename, err)
	}
}

func TestANameThatIsAlreadyRightIsLeftAlone(t *testing.T) {
	name := MachineName{Current: "srv1.corp.example.internal", Wanted: "srv1.corp.example.internal", Short: "srv1"}
	for _, keep := range []bool{false, true} {
		rename, err := hostnameAction(name, Options{KeepName: keep})
		if err != nil || rename {
			t.Fatalf("keep=%v: rename=%v err=%v", keep, rename, err)
		}
	}
}
