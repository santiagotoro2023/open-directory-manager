package main

import (
	"bufio"
	"context"
	"errors"
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

	// One reader of the terminal for the whole walkthrough: two readers on
	// the same input race.
	lines := stdinLines()

	// The phone, where the policy asks for it — and then nothing else: a
	// policy that asks for the phone asks for the phone. The control plane
	// says which by accepting or refusing the request; a policy that asks
	// for a code instead, or a domain with no notification server, refuses
	// it and the code is the walkthrough.
	switch enrolPhone(ctx, api, *username, lines) {
	case phoneDone:
		return 0
	case phoneFailed:
		return 1
	}

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

	for attempt := 1; attempt <= 3; attempt++ {
		fmt.Print("  Enter the 6-digit code it shows: ")
		line, ok := <-lines
		if !ok {
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
				<-lines
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

// How setting a phone up went.
type phoneOutcome int

const (
	phoneNotAsked phoneOutcome = iota // the policy asks for a code, not a phone
	phoneDone                         // the phone tapped Confirm, or was set up already
	phoneFailed                       // nobody tapped in time, or the console went away
)

// enrolPhone walks somebody through subscribing their phone and waits for the
// tap that proves the right phone is listening. The topic is shown once, on
// this screen, exactly as a code's secret is; nothing is written down.
func enrolPhone(
	ctx context.Context, api *client.Client, username string, lines <-chan string,
) phoneOutcome {
	enrolment, err := api.PushEnrol(ctx, username, "begin")
	if err != nil {
		var unavailable client.PushUnavailable
		if errors.As(err, &unavailable) {
			return phoneNotAsked
		}
		fmt.Fprintln(os.Stderr, "odm-agent:", err)
		return phoneFailed
	}
	if enrolment.AlreadyEnrolled {
		return phoneDone
	}

	fmt.Println()
	fmt.Println("  Set up sign-in approvals on your phone")
	fmt.Println()
	fmt.Println("  1. Install the ntfy app (Play Store, F-Droid or the App Store).")
	if enrolment.Trust != "public" {
		// The app refuses a certificate it does not know with a bare error
		// ("Trust anchor for certification path not found") and offers no
		// way past it on this path, so the certificate goes in first.
		what := "the console's certificate"
		if enrolment.Trust == "domain-ca" {
			what = "the domain's root certificate"
		}
		fmt.Println("  2. Trust " + what + " on the phone. Scan this to download it")
		fmt.Println("     (the browser will warn about the site; continue), then in ntfy:")
		fmt.Println("     Settings > Advanced > Manage certificates > Add trusted certificate,")
		fmt.Println("     and choose the downloaded file.")
		fmt.Println()
		printQR(ctx, enrolment.TrustURL)
		fmt.Println()
		fmt.Println("     ", enrolment.TrustURL)
		fmt.Println("  3. In the app: + , then \"Subscribe to topic\", then \"Use another server\".")
	} else {
		fmt.Println("  2. In the app: + , then \"Subscribe to topic\", then \"Use another server\".")
	}
	fmt.Println("     Server: ", enrolment.ServerURL)
	fmt.Println("     Topic:  ", enrolment.Topic)
	fmt.Println("     Or scan this with the phone's camera: it opens the ntfy app on the subscribe dialog.")
	fmt.Println()
	printQR(ctx, enrolment.SubscribeURL)
	fmt.Println()
	fmt.Println("     If scanning does nothing, enter the server and topic above by hand.")
	fmt.Println("  Then tap Confirm on the notification that arrives.")
	fmt.Println()
	fmt.Println("  Waiting for the tap. Press r then enter to send the notification again.")

	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			fmt.Fprintln(os.Stderr, "  Nobody tapped Confirm in time. Sign in again to try again.")
			return phoneFailed
		case line, ok := <-lines:
			if !ok {
				// The terminal went away. A nil channel is never ready, so
				// the poll carries on alone rather than spinning here.
				lines = nil
				continue
			}
			// A keystroke means "send it again"; the poll runs regardless.
			if strings.TrimSpace(strings.ToLower(line)) == "r" {
				if _, err := api.PushEnrol(ctx, username, "resend"); err == nil {
					fmt.Println("  Sent again.")
				}
			}
		case <-ticker.C:
		}
		state, err := api.PushEnrol(ctx, username, "poll")
		if err != nil {
			continue
		}
		if state.Confirmed || state.AlreadyEnrolled {
			fmt.Println()
			fmt.Println("  Phone set up. Sign-ins will ask for your approval there.")
			return phoneDone
		}
	}
}

// stdinLines hands out what is typed, one line at a time, for as long as the
// terminal is open. Closed when it is not.
func stdinLines() <-chan string {
	lines := make(chan string)
	go func() {
		defer close(lines)
		reader := bufio.NewReader(os.Stdin)
		for {
			line, err := reader.ReadString('\n')
			if line != "" {
				lines <- line
			}
			if err != nil {
				return
			}
		}
	}()
	return lines
}
