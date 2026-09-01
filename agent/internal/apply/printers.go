package apply

import (
	"context"
	"fmt"
	"os"
	"strings"

	"odm.example.org/agent/internal/policy"
)

// Printers a machine should offer.
//
// CUPS on the client points at the print server rather than driving the
// hardware itself, so nothing is installed per machine: the server holds the
// queue and the driver. This is the documented way to consume a shared CUPS
// printer, not a per-client driver install.
const printersConf = "/etc/cups/client.conf"

func applyPrinters(ctx context.Context, s policy.Settings, env Env) []policy.Result {
	if len(s.Printers) == 0 {
		return nil
	}
	if env.Run == nil {
		return []policy.Result{{
			Setting: "printers", Status: "skipped", Reason: "no command runner",
		}}
	}

	// CUPS on a desktop is socket-activated and idles out again, so lpadmin
	// can arrive while cupsd is on its way down: "Unable to connect to
	// server: Bad file descriptor". Ask for it once, before any of them.
	if _, err := os.Stat(env.Path("/usr/sbin/cupsd")); err != nil {
		return []policy.Result{{
			Setting: "printers",
			Status:  "skipped",
			Reason:  "CUPS is not installed on this machine",
		}}
	}
	_, _ = env.Run.Run(ctx, "systemctl", "start", "cups")

	results := []policy.Result{}
	var fallbackServer, defaultPrinter string

	for _, printer := range s.Printers {
		setting := "printers:" + printer.Name
		if printer.Server == "" {
			results = append(results, policy.Result{
				Setting: setting, Status: "failed", Reason: "no print server",
			})
			continue
		}
		if fallbackServer == "" {
			fallbackServer = printer.Server
		}

		// ipp://server/printers/<name> is the queue on the print server. The
		// client never needs the device the server prints to.
		uri := fmt.Sprintf("ipp://%s/printers/%s", printer.Server, printer.Name)
		out, err := env.Run.Run(ctx,
			"lpadmin", "-p", printer.Name, "-E", "-v", uri, "-m", "everywhere",
		)
		if err != nil {
			// "everywhere" asks the queue to describe itself over IPP and
			// builds the driver from the answer. A server that will not
			// answer — an older queue, one not shared over IPP, one that does
			// not exist yet — fails with "Unable to create PPD: No IPP
			// attributes", and a queue with no driver at all is better than
			// no queue: the print server renders the job either way.
			raw, rawErr := env.Run.Run(ctx, "lpadmin", "-p", printer.Name, "-E", "-v", uri)
			if rawErr != nil {
				// Reported per printer so one bad entry does not lose the rest.
				results = append(results, policy.Result{
					Setting: setting,
					Status:  "failed",
					Reason: strings.TrimSpace(
						lastLine(raw) + " " + rawErr.Error() + " (" + lastLine(out) + ")",
					),
				})
				continue
			}
			results = append(results, policy.Result{
				Setting: setting,
				Status:  "success",
				Reason: "added without a driver: " + printer.Server +
					" did not describe the queue over IPP",
			})
		} else {
			results = append(results, policy.Ok(setting))
		}
		if printer.Default {
			defaultPrinter = printer.Name
		}
	}

	// Deliberately no client.conf. ServerName there makes every CUPS command
	// on this machine talk to the print server instead of to itself — so
	// lpadmin tried to create the queue *on the server*, which refused it:
	//
	//	printers:finance-mfp  failed: lpadmin: Forbidden
	//
	// It would also hand the machine every queue the server publishes, which
	// is the opposite of a policy that names the printers somebody gets. The
	// queues created above point at the server and are local to this machine.
	if err := env.ReplaceBlock(printersConf, "", 0o644); err != nil {
		results = append(results, policy.Fail("printers:client", err))
	}
	_ = fallbackServer

	if defaultPrinter != "" {
		results = append(results, runAll(ctx, env, "printers:default",
			[]string{"lpadmin", "-d", defaultPrinter}))
	}
	return results
}

func lastLine(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	return lines[len(lines)-1]
}

// browsedConf is cups-browsed's configuration. cups-browsed finds printers on
// the network by itself and makes a queue for each, which on a machine whose
// printers come from policy means the same printer appears two and three
// times under names nobody chose: the policy's queue, cups-browsed's copy of
// it named after the server, and a third for the hardware it discovered
// directly. On a domain-managed machine the policy decides which printers
// somebody has.
const browsedConf = "/etc/cups/cups-browsed.conf"

func quietBrowsing(ctx context.Context, env Env) policy.Result {
	if _, err := os.Stat(env.Path(browsedConf)); err != nil {
		return policy.Result{
			Setting: "printers:browsing", Status: "skipped", Reason: "cups-browsed is not installed",
		}
	}
	// Nothing is discovered on a machine whose printers come from policy. Left
	// on, cups-browsed added the network printer it found by itself, and then
	// a second copy of the queue policy had already created — named
	// "brother-lab@print01.local", because the name it wanted was taken. Three
	// entries for one printer, two of which nobody asked for.
	block := "# Printers on this machine come from group policy.\n" +
		"BrowseRemoteProtocols none\n" +
		"CreateIPPPrinterQueues No\n" +
		"LocalQueueNamingRemoteCUPS RemoteName\n"
	if err := env.ReplaceBlock(browsedConf, block, 0o644); err != nil {
		return policy.Fail("printers:browsing", err)
	}
	// Queues an earlier run let it create stay behind otherwise: cups-browsed
	// removes what it made when it stops, and nothing else knows they are its.
	_, _ = env.Run.Run(ctx, "systemctl", "stop", "cups-browsed")
	_, _ = env.Run.Run(ctx, "systemctl", "start", "cups-browsed")
	return policy.Ok("printers:browsing")
}
