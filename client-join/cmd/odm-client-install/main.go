// Command odm-client-install joins this machine to an ODM domain.
//
// It is one command with flags for unattended use and prompts for anything
// left out, and it produces the same configuration as the desktop join
// application: both call the same join library (CLAUDE.md §5.6).
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"golang.org/x/term"

	"odm.example.org/client-join/join"
)

const version = "0.8.0"

func main() {
	flags := flag.NewFlagSet("odm-client-install", flag.ContinueOnError)
	flags.Usage = usage

	domain := flags.String("domain", "", "domain to join, e.g. corp.example.internal")
	server := flags.String("server", "", "a specific domain controller (discovered when omitted)")
	apiURL := flags.String("api-url", "", "the ODM control plane (derived from the domain when omitted)")
	adminUser := flags.String("admin-user", "", "join with this domain credential")
	passwordFile := flags.String("password-file", "", "read the credential's password from this file")
	otp := flags.String("otp", "", "enrol with a one-time token instead of a credential")
	ou := flags.String("ou", "", "container for the host account")
	hostname := flags.String("hostname", "", "override this machine's name")
	caCert := flags.String("ca-cert", "",
		"the console's certificate. Read from the domain's SYSVOL when omitted")
	noAgent := flags.Bool("no-agent", false, "join without installing the policy agent")
	keepName := flags.Bool("keep-hostname", false, "fail rather than rename this machine")
	unattended := flags.Bool("unattended", false, "never prompt; fail instead")
	leave := flags.Bool("leave", false, "leave the domain instead of joining it")
	force := flags.Bool("force", false, "with --leave, disconnect locally even without a credential")
	dryRun := flags.Bool("dry-run", false, "report what would happen and change nothing")
	root := flags.String("root", "", "write beneath this directory instead of /")
	showVersion := flags.Bool("version", false, "print the version and exit")

	if err := flags.Parse(os.Args[1:]); err != nil {
		os.Exit(2)
	}
	if *showVersion {
		fmt.Println("odm-client-install", version)
		return
	}

	options := join.Options{
		Domain:    *domain,
		Server:    *server,
		APIURL:    *apiURL,
		AdminUser: *adminUser,
		OTP:       *otp,
		OU:        *ou,
		Hostname:  *hostname,
		CACert:    *caCert,
		NoAgent:   *noAgent,
		KeepName:  *keepName,
		DryRun:    *dryRun,
		Root:      *root,
	}

	if *leave {
		leaveDomain(options, *passwordFile, *unattended, *force)
		return
	}

	if err := gather(&options, *passwordFile, *unattended); err != nil {
		fmt.Fprintln(os.Stderr, "odm-client-install:", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	result, err := join.Run(ctx, options, join.NewEnv(options.Root), func(step, detail string) {
		if detail == "" {
			fmt.Printf("==> %s\n", step)
			return
		}
		fmt.Printf("==> %s: %s\n", step, detail)
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "odm-client-install:", err)
		os.Exit(1)
	}

	fmt.Printf(`
Joined %s.

  Host        %s
  Realm       %s
  Controller  %s
  Method      %s
  Agent       %s

Verify with:
  klist -k /etc/krb5.keytab
  id someone@%s
  sudo odm-agent check
%s%s`, result.Domain, result.Hostname, result.Realm, result.Controller, result.Method,
		agentState(result.AgentSetUp), result.Domain, trustNote(result), rebootNote(result))
}

// trustNote is printed when the agent cannot verify the console.
//
// The join is finished and the machine is in the domain, but the agent will
// fail every request until it holds the console's certificate — so this says
// so here, with the two commands that fix it, rather than leaving a machine
// that looks joined and reports nothing.
func trustNote(result *join.Result) string {
	if !result.UntrustedConsole {
		return ""
	}
	return `
WARNING: the agent cannot verify the console's certificate, so it will not
report and no policy will be applied.

The domain publishes that certificate in SYSVOL and this machine reads it from
there, so this means the copy is missing or could not be read. On a domain
controller:

  sudo deploy/publish-console-certificate.sh

then on this machine:

  sudo odm-agent check

Or give it the certificate directly: sudo odm-agent trust /path/to/api.crt.
`
}

// leaveDomain is the reverse of a join. Removing the computer account needs a
// domain credential; severing the machine needs root here. They are separate
// rights, so --force does the second without the first and says so.
func leaveDomain(options join.Options, passwordFile string, unattended, force bool) {
	if options.Domain == "" {
		fmt.Fprintln(os.Stderr, "odm-client-install: --domain is required")
		os.Exit(2)
	}
	if options.AdminUser != "" {
		if err := readPassword(&options, passwordFile, unattended); err != nil {
			fmt.Fprintln(os.Stderr, "odm-client-install:", err)
			os.Exit(1)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	result, err := join.Leave(ctx, options, join.NewEnv(options.Root), force)
	if err != nil {
		fmt.Fprintln(os.Stderr, "odm-client-install:", err)
		os.Exit(1)
	}
	fmt.Print("\n" + result.Summary(options.Domain))
}

// rebootNote is printed when this machine was renamed to join. Long-running
// services keep the old name until they restart.
func rebootNote(result *join.Result) string {
	if !result.Renamed {
		return ""
	}
	return "\nThis machine was renamed to " + result.Hostname +
		". Reboot to restart everything still using the old name.\n"
}

func agentState(installed bool) string {
	if installed {
		return "installed and enabled"
	}
	return "not installed"
}

// gather fills in anything the flags left out, prompting unless unattended.
func gather(options *join.Options, passwordFile string, unattended bool) error {
	reader := bufio.NewReader(os.Stdin)

	if options.Domain == "" {
		if unattended {
			return errors.New("--domain is required")
		}
		value, err := prompt(reader, "Domain")
		if err != nil {
			return err
		}
		options.Domain = value
	}

	if options.OTP == "" && options.AdminUser == "" {
		if unattended {
			return errors.New("either --admin-user or --otp is required")
		}
		value, err := prompt(reader, "Administrator account (blank to use an enrolment token)")
		if err != nil {
			return err
		}
		if value == "" {
			token, err := prompt(reader, "Enrolment token")
			if err != nil {
				return err
			}
			options.OTP = token
		} else {
			options.AdminUser = value
		}
	}

	return readPassword(options, passwordFile, unattended)
}

// readPassword fills in the credential's password from a file, a prompt, or
// neither when there is no credential to read one for.
func readPassword(options *join.Options, passwordFile string, unattended bool) error {
	if options.AdminUser == "" || options.Password != "" {
		return nil
	}
	switch {
	// Set by an unattended install. The same name setup.sh takes, so one
	// provisioning script does not need two spellings. Never echoed, and
	// never written anywhere.
	case os.Getenv("ODM_ADMIN_PASSWORD") != "":
		options.Password = os.Getenv("ODM_ADMIN_PASSWORD")
	case passwordFile != "":
		body, err := os.ReadFile(passwordFile)
		if err != nil {
			return fmt.Errorf("cannot read the password file: %w", err)
		}
		options.Password = strings.TrimRight(string(body), "\r\n")
	case unattended:
		return errors.New("--password-file is required with --admin-user when unattended")
	default:
		password, err := promptSecret(fmt.Sprintf("Password for %s", options.AdminUser))
		if err != nil {
			return err
		}
		options.Password = password
	}
	return nil
}

func prompt(reader *bufio.Reader, label string) (string, error) {
	fmt.Printf("%s: ", label)
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

func promptSecret(label string) (string, error) {
	fmt.Printf("%s: ", label)
	// A pipe is not a terminal, and term.ReadPassword on one fails with
	// "inappropriate ioctl for device" — which made the command that exists
	// for scripted provisioning impossible to script. Read the line instead;
	// there is no echo to turn off when nobody is typing.
	if !term.IsTerminal(int(syscall.Stdin)) {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		fmt.Println()
		if line == "" && err != nil {
			return "", fmt.Errorf(
				"no password on standard input; use --password-file or ODM_ADMIN_PASSWORD",
			)
		}
		return strings.TrimRight(line, "\r\n"), nil
	}
	secret, err := term.ReadPassword(int(syscall.Stdin))
	fmt.Println()
	if err != nil {
		return "", fmt.Errorf("cannot read the password: %w", err)
	}
	return string(secret), nil
}

func usage() {
	fmt.Fprint(os.Stderr, `usage: odm-client-install --domain <domain> [flags]

Joins this machine to an ODM domain: creates its account, installs its
Kerberos keytab, configures identity and authentication, and installs the
policy agent.

  --domain          domain to join, e.g. corp.example.internal
  --server          a specific domain controller (discovered when omitted)
  --api-url         the ODM control plane (derived from the domain when omitted)
  --admin-user      join with this domain credential
  --password-file   read that credential's password from a file. ODM_ADMIN_PASSWORD
                    in the environment does the same, and standard input is
                    read when it is not a terminal.
  --otp             enrol with a one-time token instead of a credential
  --ou              container for the host account
  --hostname        override this machine's name
  --ca-cert         the console's certificate. Read from the domain when omitted
  --no-agent        join without installing the policy agent
  --keep-hostname   fail rather than rename this machine to its domain name
  --unattended      never prompt; fail instead
  --dry-run         report what would happen and change nothing
  --root            write beneath this directory instead of /, for testing
  --version

Leaving again:

  --leave           leave the domain instead of joining it
  --force           with --leave, disconnect this machine even without a
                    credential, leaving its account for an administrator

Removing the computer account from the directory needs a domain credential;
disconnecting this machine needs root here. Both need root.

Anything omitted is prompted for, unless --unattended is given.
`)
}
