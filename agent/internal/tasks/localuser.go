package tasks

import (
	"context"
	"fmt"
	"os/user"
	"regexp"
	"strconv"
	"strings"

	"odm.example.org/agent/internal/apply"
)

// Local accounts on a domain-joined machine are the exception, not the rule —
// a service account, a break-glass login — but they exist, and an operator who
// can see them in the console should not have to open a terminal to add one.
//
// Directory accounts are not managed from here. Those are objects in the
// directory, and creating one here would make a second, unreplicated identity
// with the same name.

// Debian's own rule for a login name, which is what adduser enforces.
var safeLogin = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

// The lowest uid Debian gives an ordinary account. Anything below it belongs
// to the system, and ODM will not create or remove it.
const firstNormalUID = 1000

func addLocalUser(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	name := str(payload["name"])
	if !safeLogin.MatchString(name) {
		return "", fmt.Errorf("%q is not a valid login name", name)
	}
	if _, err := user.Lookup(name); err == nil {
		return "", fmt.Errorf("%s already exists on this machine", name)
	}
	groups, err := stringList(payload["groups"], safeLogin)
	if err != nil {
		return "", fmt.Errorf("group names: %w", err)
	}
	shell := str(payload["shell"])
	if shell == "" {
		shell = "/bin/bash"
	}
	if !strings.HasPrefix(shell, "/") || strings.ContainsAny(shell, " \t\n") {
		return "", fmt.Errorf("%q is not a shell path", shell)
	}
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}

	arguments := []string{"--create-home", "--shell", shell}
	if comment := str(payload["full_name"]); comment != "" {
		if strings.ContainsAny(comment, ":\n") {
			return "", fmt.Errorf("a full name may not contain a colon or a newline")
		}
		arguments = append(arguments, "--comment", comment)
	}
	if len(groups) > 0 {
		arguments = append(arguments, "--groups", strings.Join(groups, ","))
	}
	if out, err := unsandboxed(ctx, env, nil, "useradd", append(arguments, name)...); err != nil {
		return out, fmt.Errorf("useradd %s: %w", name, err)
	}

	password := str(payload["password"])
	if password == "" {
		// No password means no password login, not an empty one.
		if out, err := unsandboxed(ctx, env, nil, "passwd", "--lock", name); err != nil {
			return out, fmt.Errorf("locking %s: %w", name, err)
		}
		return name + " created, with password login locked", nil
	}
	// Through stdin, so the password is never an argument in the process list.
	if err := apply.SetPassword(ctx, env, name, password); err != nil {
		return "", err
	}
	return name + " created", nil
}

func removeLocalUser(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	name := str(payload["name"])
	if !safeLogin.MatchString(name) {
		return "", fmt.Errorf("%q is not a valid login name", name)
	}
	found, err := user.Lookup(name)
	if err != nil {
		return "", fmt.Errorf("%s does not exist on this machine", name)
	}
	// A system account is part of how the machine works. Removing one from a
	// console that lists accounts is a very short path to an unbootable host.
	uid, err := strconv.Atoi(found.Uid)
	if err != nil || uid < firstNormalUID {
		return "", fmt.Errorf(
			"%s is a system account (uid %s); ODM will not remove it", name, found.Uid,
		)
	}
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	out, err := unsandboxed(ctx, env, nil, "userdel", "--remove", name)
	if err != nil {
		return out, fmt.Errorf("userdel %s: %w", name, err)
	}
	return name + " removed, home directory included", nil
}
