package tasks

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"strings"

	"odm.example.org/agent/internal/apply"
	"odm.example.org/agent/internal/inventory"
)

// A recovery key for an encrypted disk, put into a spare LUKS key slot.
//
// cryptsetup needs an existing passphrase before it will add another. There
// is no way round that and there should not be: a machine that could add a
// key slot to its own disk unprompted would be a machine whose disk anybody
// with root on the control plane could unlock. So the existing passphrase is
// supplied once by an operator, used on the machine, and never written down
// anywhere — what comes back is the new recovery passphrase alone.
//
// Machines installed by the PXE role escrow at install instead, and never
// need this.

// The alphabet a recovery passphrase is written in. No characters that read
// two ways when somebody is copying one off a screen at a locked machine.
const recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

const recoveryGroups, recoveryGroupSize = 6, 5

func escrowRecoveryKey(
	ctx context.Context, payload map[string]any, env apply.Env,
) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	device := strings.TrimSpace(str(payload["device"]))
	if !safeDevice(device) {
		return "", fmt.Errorf("%q is not a block device", device)
	}
	existing := str(payload["passphrase"])
	if existing == "" {
		return "", fmt.Errorf("the disk's current passphrase is needed to add another key")
	}

	// It has to be a LUKS device with somewhere to put the key, and saying so
	// here is better than a cryptsetup error an operator has to interpret.
	if _, err := env.Run.Run(ctx, "cryptsetup", "isLuks", env.Path(device)); err != nil {
		return "", fmt.Errorf("%s is not an encrypted volume", device)
	}

	recovery, err := recoveryPassphrase()
	if err != nil {
		return "", err
	}

	// Neither passphrase ever reaches a command line, where the machine's own
	// process list would carry it. The existing one goes in on standard
	// input, which is what --key-file=- means; the new one goes in a file
	// only this process can read, because luksAddKey would otherwise ask for
	// it at a terminal there is not one of here.
	keyFile, err := os.CreateTemp("", "odm-recovery")
	if err != nil {
		return "", err
	}
	defer os.Remove(keyFile.Name())
	if err := os.Chmod(keyFile.Name(), 0o600); err != nil {
		return "", err
	}
	if _, err := keyFile.WriteString(recovery); err != nil {
		return "", err
	}
	keyFile.Close()

	add := exec.CommandContext(ctx, "cryptsetup", "luksAddKey", "--batch-mode",
		"--key-file=-", env.Path(device), keyFile.Name())
	add.Stdin = strings.NewReader(existing)
	out, err := add.CombinedOutput()
	if err != nil {
		// Never the passphrase, whatever cryptsetup decided to print.
		return "", fmt.Errorf("cryptsetup refused the key: %s",
			strings.TrimSpace(redact(string(out), existing, recovery)))
	}

	body, err := json.Marshal(map[string]any{
		"device":     device,
		"passphrase": recovery,
		"volumes":    inventory.Encryption(ctx, env),
	})
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// redact keeps a passphrase out of a message that is about to be stored and
// shown. Cheap insurance: cryptsetup does not echo one, and if a future
// version does this is what stops it reaching the audit log.
func redact(text string, secrets ...string) string {
	for _, secret := range secrets {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, "[redacted]")
		}
	}
	return text
}

// recoveryPassphrase is what somebody types at a locked machine, so it is
// grouped and has no character that reads two ways on a screen.
func recoveryPassphrase() (string, error) {
	groups := make([]string, 0, recoveryGroups)
	for range recoveryGroups {
		var group strings.Builder
		for range recoveryGroupSize {
			index, err := rand.Int(rand.Reader, big.NewInt(int64(len(recoveryAlphabet))))
			if err != nil {
				return "", err
			}
			group.WriteByte(recoveryAlphabet[index.Int64()])
		}
		groups = append(groups, group.String())
	}
	return strings.Join(groups, "-"), nil
}

func safeDevice(device string) bool {
	if !strings.HasPrefix(device, "/dev/") || len(device) > 128 {
		return false
	}
	for _, r := range strings.TrimPrefix(device, "/dev/") {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '/':
		default:
			return false
		}
	}
	return !strings.Contains(device, "..")
}
