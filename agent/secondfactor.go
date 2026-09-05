package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"odm.example.org/agent/internal/client"
	"odm.example.org/agent/internal/config"
)

// Setting up a second factor, at the machine.
//
// Somebody signing in for the first time under a policy that asks for one is
// walked through it here rather than being sent to the console: the console is
// the administrator's, and a person who cannot sign in has no way to reach it
// anyway. What they get is what any other service gives them — a QR code to
// scan, or a secret to paste into a password manager, and a code to type back
// to prove it worked.
//
// The secret is made by the control plane and confirmed there. This machine
// carries it for as long as it takes to draw the QR code and no longer.

func runEnrolFactor(args []string) int {
	flags := flag.NewFlagSet("enrol-factor", flag.ExitOnError)
	username := flags.String("user", "", "the account enrolling")
	configPath := flags.String("config", config.DefaultPath, "agent configuration")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *username == "" {
		fmt.Fprintln(os.Stderr, "odm-agent: --user is required")
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	settings, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent:", err)
		return 1
	}
	api, err := client.New(settings, version)
	if err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent:", err)
		return 1
	}
	defer api.Close()

	start, err := api.BeginSecondFactor(ctx, *username)
	if err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent:", err)
		return 1
	}
	if start.AlreadyEnrolled {
		fmt.Println("A second factor is already set up for this account.")
		return 0
	}

	fmt.Println()
	fmt.Println("  Set up your second factor")
	fmt.Println()
	fmt.Println("  Scan this with your authenticator app or password manager.")
	fmt.Println()
	printQR(ctx, start.URI)
	fmt.Println()
	fmt.Println("  If you cannot scan it, add an account by hand with this key:")
	fmt.Println()
	fmt.Println("     ", spaced(start.Secret))
	fmt.Println()

	reader := bufio.NewReader(os.Stdin)
	for attempt := 1; attempt <= 3; attempt++ {
		fmt.Print("  Enter the 6-digit code it shows: ")
		line, err := reader.ReadString('\n')
		if err != nil {
			fmt.Fprintln(os.Stderr, "\nodm-agent: nothing to read; run 'odm-agent enrol-factor' again")
			return 1
		}
		code := strings.TrimSpace(line)
		done, err := api.ConfirmSecondFactor(ctx, *username, code)
		if err == nil {
			fmt.Println()
			fmt.Println("  Set up. You will be asked for a code from now on.")
			if len(done.RecoveryCodes) > 0 {
				fmt.Println()
				fmt.Println("  Keep these somewhere other than the device, in case you lose it.")
				fmt.Println("  Each one works once.")
				fmt.Println()
				for _, recovery := range done.RecoveryCodes {
					fmt.Println("     ", recovery)
				}
				fmt.Println()
				fmt.Print("  Press enter once you have written them down. ")
				_, _ = reader.ReadString('\n')
			}
			return 0
		}
		fmt.Fprintf(os.Stderr, "  %s\n", err)
	}
	fmt.Fprintln(os.Stderr, "  Not set up. Run 'odm-agent enrol-factor' to try again.")
	return 1
}

// printQR draws the enrolment URI as a square somebody can point a phone at.
//
// qrencode does the drawing: it is a Debian package, it renders to the
// terminal, and generating a QR code is not something to write by hand in an
// agent that runs as root. Without it the secret above is still enough — every
// authenticator takes a typed key.
func printQR(ctx context.Context, uri string) {
	render := exec.CommandContext(ctx, "qrencode", "-t", "ANSIUTF8", "-m", "2", uri)
	render.Stdout = os.Stdout
	render.Stderr = nil
	if err := render.Run(); err != nil {
		fmt.Println("  (install qrencode to show a QR code here)")
	}
}

// spaced breaks the key into groups, because somebody is typing it.
func spaced(secret string) string {
	var out strings.Builder
	for index, r := range secret {
		if index > 0 && index%4 == 0 {
			out.WriteByte(' ')
		}
		out.WriteRune(r)
	}
	return out.String()
}
