package apply

import (
	"context"
	"fmt"
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
			// A printer the server has not published yet, or an older queue
			// that is not driverless. Reported per printer so one bad entry
			// does not lose the rest.
			results = append(results, policy.Result{
				Setting: setting,
				Status:  "failed",
				Reason:  strings.TrimSpace(lastLine(out) + " " + err.Error()),
			})
			continue
		}
		results = append(results, policy.Ok(setting))
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
