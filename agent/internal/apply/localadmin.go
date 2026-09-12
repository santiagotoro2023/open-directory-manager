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
	state := loadLocalAdminState(env)

	if wanted == nil {
		// A policy that stops naming a local administrator has to take the
		// account it created back off every machine that got it, not just
		// stop rotating its password — otherwise unlinking the policy leaves
		// an administrator account nobody in the console can see, on every
		// machine it was ever pushed to, for somebody to find and remove by
		// hand.
		return removeLocalAdministrator(ctx, env, state)
	}
	if wanted.Account == "" {
		return failed("no account name")
	}

	var renameResults []policy.Result
	if state.Account != "" && state.Account != wanted.Account {
		// The account named changed. The old one is not this policy's
		// account any more and goes the same way as if the setting had been
		// removed outright, or the machine ends up with both.
		renameResults = removeLocalAdministrator(ctx, env, state)
		state = localAdminState{}
	}

	rotateDays := wanted.RotateDays
	if rotateDays <= 0 {
		rotateDays = 30
	}
	length := wanted.Length
	if length < 12 {
		length = 20
	}

	due := state.Account != wanted.Account ||
		state.Password == "" ||
		time.Since(state.Rotated) >= time.Duration(rotateDays)*24*time.Hour

	// Whatever this call reports from here on, it reports alongside the old
	// account's removal rather than instead of it: a rename is two things
	// happening in one pass, and only one of them having a line in the RSoP
	// reads as the other one never having happened.
	fail := func(reason string) []policy.Result {
		return append(renameResults, failed(reason)...)
	}

	if !due {
		return append(renameResults, policy.Result{
			Setting: "local_administrator",
			Status:  "unchanged",
			Reason:  fmt.Sprintf("next rotation in %d days", rotateDays-int(time.Since(state.Rotated).Hours()/24)),
		})
	}

	password, err := generatePassword(length)
	if err != nil {
		return fail(err.Error())
	}

	if env.Run == nil {
		return fail("no command runner")
	}
	// Created if missing; its password set either way. --disabled-password so
	// adduser does not prompt, then chpasswd sets the one we generated.
	if _, err := env.Run.Run(ctx, "id", "-u", wanted.Account); err != nil {
		if out, err := env.Run.Run(ctx, "useradd", "--create-home", "--shell", "/bin/bash",
			"--comment", "Managed by Open Directory Manager", wanted.Account); err != nil {
			return fail("creating the account: " + out + err.Error())
		}
	}
	// chpasswd reads the pair from standard input rather than argv, so the
	// password never appears in the process list.
	if err := SetPassword(ctx, env, wanted.Account, password); err != nil {
		return fail("setting the password: " + err.Error())
	}

	// Sudo through the same file the sudo appliers own, so removing the
	// setting removes the rights with it.
	sudoers := env.Path("/etc/sudoers.d/odm-local-administrator")
	if wanted.Administrator {
		body := Header + wanted.Account + " ALL=(ALL:ALL) ALL\n"
		if err := os.MkdirAll(filepath.Dir(sudoers), 0o755); err != nil {
			return fail(err.Error())
		}
		if err := os.WriteFile(sudoers, []byte(body), 0o440); err != nil {
			return fail(err.Error())
		}
	} else {
		_ = os.Remove(sudoers)
	}

	rotated := time.Now().UTC()
	if err := saveLocalAdminState(env, localAdminState{
		Account: wanted.Account, Rotated: rotated, Password: password,
	}); err != nil {
		return fail(err.Error())
	}

	// Handed to the control plane by the report that follows this run. It is
	// not written into the policy or anywhere world-readable.
	pendingLocalAdmin = &PendingLocalAdministrator{
		Account:   wanted.Account,
		Password:  password,
		Rotated:   rotated,
		ExpiresAt: rotated.Add(time.Duration(rotateDays) * 24 * time.Hour),
	}

	return append(renameResults, policy.Result{
		Setting: "local_administrator",
		Status:  "applied",
		Reason:  fmt.Sprintf("%s rotated, next in %d days", wanted.Account, rotateDays),
	})
}

// removeLocalAdministrator takes the account a local-administrator policy
// created back off this machine: the same account, taken back the same way
// whether the setting was unlinked outright or its account name simply
// changed to a different one.
//
// Only the account this policy is recorded as having created is ever
// touched — never one an operator happens to have named the same thing by
// hand on some other machine, which is why this reads the state file rather
// than the account name in the policy that no longer names one.
func removeLocalAdministrator(ctx context.Context, env Env, state localAdminState) []policy.Result {
	if state.Account == "" {
		return nil // this machine never had one; nothing to take back
	}
	var results []policy.Result
	if err := os.Remove(env.Path("/etc/sudoers.d/odm-local-administrator")); err != nil && !os.IsNotExist(err) {
		results = append(results, policy.Fail("local_administrator", err))
	}
	if env.Run != nil {
		if _, err := env.Run.Run(ctx, "id", "-u", state.Account); err == nil {
			// -r takes the home directory and mail spool with it; -f drops
			// the account even if a stale login still shows it as signed in,
			// which a service account nobody signs into interactively must
			// never be left behind over.
			if out, err := env.Run.Run(ctx, "userdel", "-r", "-f", state.Account); err != nil {
				results = append(results, policy.Result{
					Setting: "local_administrator",
					Status:  "failed",
					Reason: fmt.Sprintf("removing %s: %v: %s", state.Account, err,
						strings.TrimSpace(lastLine(out))),
				})
			}
		}
	}
	if err := os.Remove(env.Path(localAdminStatePath)); err != nil && !os.IsNotExist(err) {
		results = append(results, policy.Fail("local_administrator", err))
	}
	if len(results) == 0 {
		results = append(results, policy.Result{
			Setting: "local_administrator",
			Status:  "success",
			Reason:  state.Account + " removed: no longer in policy",
		})
	}
	return results
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
