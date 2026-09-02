package apply

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Password rules for accounts that live on this machine.
//
// Domain accounts are not covered and cannot be: their rules are held on the
// domain object and enforced by the directory on every change. What a local
// password may be is pam_pwquality; how long it lasts is login.defs for new
// accounts and chage for the ones that already exist.
const (
	pwqualityPath = "/etc/security/pwquality.conf.d/50-odm.conf"
	loginDefsPath = "/etc/login.defs"

	// The lowest uid a person's account gets on Debian. Below it are the
	// accounts services run as, which nobody signs in to.
	firstUserID = 1000
)

func applyLocalPasswordPolicy(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if s.LocalPasswordPolicy == nil {
		return nil
	}
	rules := *s.LocalPasswordPolicy
	var done []string

	// What a new local password may be. Written to pwquality's own drop-in
	// directory rather than to its main file, so the machine's file is left
	// as the distribution ships it.
	body := "# Managed by Open Directory Manager. Edits here are overwritten.\n"
	body += fmt.Sprintf("minlen = %d\n", rules.MinimumLength)
	// pwquality counts a class as a credit: -1 requires one of that class,
	// 0 neither requires nor rewards it.
	for _, class := range []struct {
		key      string
		required bool
	}{
		{"ucredit", rules.RequireUppercase},
		{"lcredit", rules.RequireLowercase},
		{"dcredit", rules.RequireDigit},
		{"ocredit", rules.RequireSymbol},
	} {
		if class.required {
			body += class.key + " = -1\n"
		} else {
			body += class.key + " = 0\n"
		}
	}
	if err := env.WriteFile(pwqualityPath, body, 0o644, "root", "root"); err != nil {
		return refused(err)
	}
	done = append(done, "password rules written")

	// The file means nothing unless pam_pwquality is in the stack, and on
	// Debian the module arrives with libpam-pwquality, whose own packaging
	// adds it to common-password.
	if env.Run != nil && !hasPwquality(ctx, env) {
		if out, err := env.Run.Run(ctx, "apt-get", "install", "-y",
			"--no-install-recommends", "libpam-pwquality"); err != nil {
			return []policy.Result{{
				Setting: "local_password_policy",
				Status:  "failed",
				Reason:  fmt.Sprintf("installing libpam-pwquality: %v: %s", err, out),
			}}
		}
		done = append(done, "libpam-pwquality installed")
	}

	// How long a password lasts, for accounts made from here on. A block
	// rather than the whole file: login.defs is the machine's, and the last
	// value read is the one that applies.
	ages := ""
	if rules.MaximumAgeDays > 0 {
		ages += fmt.Sprintf("PASS_MAX_DAYS\t%d\n", rules.MaximumAgeDays)
	}
	if rules.MinimumAgeDays > 0 {
		ages += fmt.Sprintf("PASS_MIN_DAYS\t%d\n", rules.MinimumAgeDays)
	}
	if rules.WarnDays > 0 {
		ages += fmt.Sprintf("PASS_WARN_AGE\t%d\n", rules.WarnDays)
	}
	if err := env.ReplaceBlock(loginDefsPath, ages, 0o644); err != nil {
		return refused(err)
	}

	// And for the accounts that already exist, which login.defs does not
	// reach. Named accounts, or every account a person could sign in to.
	if env.Run != nil && ages != "" {
		accounts := rules.Accounts
		if len(accounts) == 0 {
			accounts = localAccounts(env)
		}
		changed := 0
		for _, account := range accounts {
			args := []string{}
			if rules.MaximumAgeDays > 0 {
				args = append(args, "-M", strconv.Itoa(rules.MaximumAgeDays))
			}
			if rules.MinimumAgeDays > 0 {
				args = append(args, "-m", strconv.Itoa(rules.MinimumAgeDays))
			}
			if rules.WarnDays > 0 {
				args = append(args, "-W", strconv.Itoa(rules.WarnDays))
			}
			if len(args) == 0 {
				continue
			}
			if _, err := env.Run.Run(ctx, "chage", append(args, account)...); err == nil {
				changed++
			}
		}
		done = append(done, fmt.Sprintf("%d account(s) aged", changed))
	}

	return []policy.Result{{
		Setting: "local_password_policy",
		Status:  "applied",
		Reason:  strings.Join(done, "; "),
	}}
}

// hasPwquality reports whether the module is on the machine already.
func hasPwquality(ctx context.Context, env Env) bool {
	out, err := env.Run.Run(ctx, "dpkg-query", "-W", "-f=${db:Status-Status}", "libpam-pwquality")
	return err == nil && strings.Contains(out, "installed")
}

// localAccounts lists the accounts on this machine somebody could sign in to:
// uid at or above the first user id, and not the nobody account.
func localAccounts(env Env) []string {
	raw, err := os.ReadFile(env.Path("/etc/passwd"))
	if err != nil {
		return nil
	}
	var accounts []string
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Split(line, ":")
		if len(fields) < 7 {
			continue
		}
		uid, err := strconv.Atoi(fields[2])
		if err != nil || uid < firstUserID || uid >= 65534 {
			continue
		}
		if strings.HasSuffix(fields[6], "nologin") || strings.HasSuffix(fields[6], "false") {
			continue
		}
		accounts = append(accounts, fields[0])
	}
	return accounts
}

func refused(err error) []policy.Result {
	return []policy.Result{{
		Setting: "local_password_policy",
		Status:  "failed",
		Reason:  err.Error(),
	}}
}
