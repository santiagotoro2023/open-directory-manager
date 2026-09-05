package tasks

import (
	"strings"
	"testing"
)

func TestARecoveryPassphraseIsSomethingSomebodyCanTypeAtALockedMachine(t *testing.T) {
	seen := map[string]bool{}
	for range 50 {
		phrase, err := recoveryPassphrase()
		if err != nil {
			t.Fatal(err)
		}
		if seen[phrase] {
			t.Fatal("the same passphrase came back twice")
		}
		seen[phrase] = true

		groups := strings.Split(phrase, "-")
		if len(groups) != recoveryGroups {
			t.Fatalf("%q is not %d groups", phrase, recoveryGroups)
		}
		for _, group := range groups {
			if len(group) != recoveryGroupSize {
				t.Fatalf("%q has a group of %d", phrase, len(group))
			}
		}
		// Nothing that reads two ways on a screen: no O and 0, no I, l and 1.
		for _, character := range phrase {
			if character == '-' {
				continue
			}
			if !strings.ContainsRune(recoveryAlphabet, character) {
				t.Fatalf("%q contains %q, which somebody will mistype", phrase, character)
			}
		}
	}
}

func TestOnlyABlockDeviceIsAcceptedForEscrow(t *testing.T) {
	for _, good := range []string{"/dev/sda1", "/dev/nvme0n1p3", "/dev/mapper/root"} {
		if !safeDevice(good) {
			t.Errorf("%q should be a device", good)
		}
	}
	for _, bad := range []string{
		"", "/etc/shadow", "/dev/../etc/shadow", "/dev/sda1; rm -rf /", "/dev/sda1 /etc/passwd",
	} {
		if safeDevice(bad) {
			t.Errorf("%q should not be a device", bad)
		}
	}
}

func TestNeitherPassphraseCanReachAMessageThatIsStored(t *testing.T) {
	// cryptsetup does not echo one today; this is what stops a future version
	// putting one in the audit log.
	message := redact("cryptsetup: bad key hunter2 / ABCDE-FGHIJ", "hunter2", "ABCDE-FGHIJ")
	if strings.Contains(message, "hunter2") || strings.Contains(message, "ABCDE-FGHIJ") {
		t.Errorf("a passphrase survived: %s", message)
	}
	if !strings.Contains(message, "[redacted]") {
		t.Errorf("nothing was redacted: %s", message)
	}
}
