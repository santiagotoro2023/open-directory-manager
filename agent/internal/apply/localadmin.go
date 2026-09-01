package apply

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"odm.example.org/agent/internal/policy"
)

// Where the machine remembers when it last rotated, so a restart does not
// mean a new password every fifteen minutes.
const localAdminStatePath = "/var/lib/odm/local-administrator.json"

// The alphabet a generated password is drawn from. No characters that a
// person reading one off a screen would get wrong: no O/0, no l/1/I.
const passwordAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_=+.,@#%"

type localAdminState struct {
	Account  string    `json:"account"`
	Rotated  time.Time `json:"rotated"`
	Password string    `json:"password"`
}

// PendingLocalAdministrator is what the agent reports after applying, so the
// control plane can show the current password on the computer object. It is
// read by main and cleared once the report succeeds.
type PendingLocalAdministrator struct {
	Account   string    `json:"account"`
	Password  string    `json:"password"`
	Rotated   time.Time `json:"rotated"`
	ExpiresAt time.Time `json:"expires_at"`
}

var pendingLocalAdmin *PendingLocalAdministrator

// TakePendingLocalAdministrator returns the credential this run produced, if
// any, and forgets it.
func TakePendingLocalAdministrator() *PendingLocalAdministrator {
	pending := pendingLocalAdmin
	pendingLocalAdmin = nil
	return pending
}

func applyLocalAdministrator(
	ctx context.Context, settings policy.Settings, env Env,
) []policy.Result {
	wanted := settings.LocalAdministrator
	if wanted == nil {
		return nil
	}
	if wanted.Account == "" {
		return failed("no account name")
	}
	rotateDays := wanted.RotateDays
	if rotateDays <= 0 {
		rotateDays = 30
	}
	length := wanted.Length
	if length < 12 {
		length = 20
	}

	state := loadLocalAdminState(env)
	due := state.Account != wanted.Account ||
		state.Password == "" ||
		time.Since(state.Rotated) >= time.Duration(rotateDays)*24*time.Hour

	if !due {
		return []policy.Result{{
			Setting: "local_administrator",
			Status:  "unchanged",
			Reason:  fmt.Sprintf("next rotation in %d days", rotateDays-int(time.Since(state.Rotated).Hours()/24)),
		}}
	}

	password, err := generatePassword(length)
	if err != nil {
		return failed(err.Error())
	}

	if env.Run == nil {
		return failed("no command runner")
	}
	// Created if missing; its password set either way. --disabled-password so
	// adduser does not prompt, then chpasswd sets the one we generated.
	if _, err := env.Run.Run(ctx, "id", "-u", wanted.Account); err != nil {
		if out, err := env.Run.Run(ctx, "useradd", "--create-home", "--shell", "/bin/bash",
			"--comment", "Managed by Open Directory Manager", wanted.Account); err != nil {
			return failed("creating the account: " + out + err.Error())
		}
	}
	// chpasswd reads the pair from standard input rather than argv, so the
	// password never appears in the process list.
	if err := SetPassword(ctx, env, wanted.Account, password); err != nil {
		return failed("setting the password: " + err.Error())
	}

	// Sudo through the same file the sudo appliers own, so removing the
	// setting removes the rights with it.
	sudoers := env.Path("/etc/sudoers.d/odm-local-administrator")
	if wanted.Administrator {
		body := Header + wanted.Account + " ALL=(ALL:ALL) ALL\n"
		if err := os.MkdirAll(filepath.Dir(sudoers), 0o755); err != nil {
			return failed(err.Error())
		}
		if err := os.WriteFile(sudoers, []byte(body), 0o440); err != nil {
			return failed(err.Error())
		}
	} else {
		_ = os.Remove(sudoers)
	}

	rotated := time.Now().UTC()
	if err := saveLocalAdminState(env, localAdminState{
		Account: wanted.Account, Rotated: rotated, Password: password,
	}); err != nil {
		return failed(err.Error())
	}

	// Handed to the control plane by the report that follows this run. It is
	// not written into the policy or anywhere world-readable.
	pendingLocalAdmin = &PendingLocalAdministrator{
		Account:   wanted.Account,
		Password:  password,
		Rotated:   rotated,
		ExpiresAt: rotated.Add(time.Duration(rotateDays) * 24 * time.Hour),
	}

	return []policy.Result{{
		Setting: "local_administrator",
		Status:  "applied",
		Reason:  fmt.Sprintf("%s rotated, next in %d days", wanted.Account, rotateDays),
	}}
}

// SetPassword pipes "account:password" into chpasswd. Done here rather than
// through the shared Runner because that one takes no standard input, and a
// password passed as an argument is readable by every process on the machine.
func SetPassword(ctx context.Context, env Env, account, password string) error {
	command := exec.CommandContext(ctx, "chpasswd")
	command.Stdin = strings.NewReader(account + ":" + password + "\n")
	var errOut bytes.Buffer
	command.Stderr = &errOut
	if err := command.Run(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(errOut.String()))
	}
	return nil
}

func failed(reason string) []policy.Result {
	return []policy.Result{{Setting: "local_administrator", Status: "failed", Reason: reason}}
}

// generatePassword draws from crypto/rand. math/rand would be predictable
// from the time the machine booted, which is not a secret.
func generatePassword(length int) (string, error) {
	var out strings.Builder
	limit := big.NewInt(int64(len(passwordAlphabet)))
	for i := 0; i < length; i++ {
		index, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return "", fmt.Errorf("generating a password: %w", err)
		}
		out.WriteByte(passwordAlphabet[index.Int64()])
	}
	return out.String(), nil
}

func loadLocalAdminState(env Env) localAdminState {
	var state localAdminState
	body, err := os.ReadFile(env.Path(localAdminStatePath))
	if err != nil {
		return state
	}
	_ = json.Unmarshal(body, &state)
	return state
}

func saveLocalAdminState(env Env, state localAdminState) error {
	path := env.Path(localAdminStatePath)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	body, err := json.Marshal(state)
	if err != nil {
		return err
	}
	// 0600: the current password is in here, for the machine's own use.
	return os.WriteFile(path, body, 0o600)
}
