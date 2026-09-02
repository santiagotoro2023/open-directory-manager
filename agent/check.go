package main

import (
	"context"
	"crypto/x509"
	certpem "encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jcmturner/gokrb5/v8/keytab"

	"odm.example.org/agent/internal/apply"
	"odm.example.org/agent/internal/client"
	"odm.example.org/agent/internal/config"
	"odm.example.org/agent/internal/inventory"
	"odm.example.org/agent/internal/trust"
)

// odm-agent check: why this machine is not reporting.
//
// A machine that has joined the domain and then reports nothing gives an
// operator one symptom and no way in. Every step between "joined" and
// "reporting" is checked here in order, each with the real error, so the
// answer is a line rather than an afternoon: the name does not resolve, the
// certificate is not trusted, the keytab does not hold this machine's
// account, the clock is out, the control plane refused the ticket.
//
// Read-only apart from the check-in it ends with, which is the same request
// the daemon makes.
func runCheck(args []string) int {
	configPath := config.DefaultPath
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		configPath = args[0]
	}

	failed := false
	step := func(what string, err error, hint string) {
		if err == nil {
			fmt.Printf("  ok    %s\n", what)
			return
		}
		failed = true
		fmt.Printf("  FAIL  %s: %v\n", what, err)
		if hint != "" {
			fmt.Printf("        %s\n", hint)
		}
	}

	fmt.Printf("odm-agent %s checking %s\n\n", version, configPath)

	cfg, err := config.Load(configPath)
	step("configuration", err,
		"Written by the domain join. Re-run odm-client-install, or install-agent.sh on a controller.")
	if err != nil {
		return 1
	}
	fmt.Printf("        control plane %s\n", cfg.APIURL)
	fmt.Printf("        service       %s\n", cfg.ServicePrincipal)
	fmt.Printf("        realm         %s\n", cfg.Realm)

	// The keytab, and whether this machine's own account is in it. A keytab
	// for another host authenticates as that host or not at all.
	principal, err := client.MachinePrincipal()
	step("machine account", err, "")
	if err == nil {
		step("keytab "+cfg.Keytab, keytabHolds(cfg.Keytab, principal),
			"Re-join the domain, or on a controller: samba-tool domain exportkeytab "+
				"/etc/krb5.keytab --principal="+principal)
	}

	// A certificate that cannot be verified is the one failure the machine can
	// fix by itself: the domain publishes the console's certificate in SYSVOL,
	// and this is the same fetch the service does on its own pass.
	reach := client.Reachable(cfg)
	if trust.Untrusted(reach) {
		if _, err := trust.FromDomain(context.Background(), cfg, configPath,
			apply.NewEnv("")); err == nil {
			fmt.Println("  ..    fetched the console's certificate from the domain")
			if healed, err := config.Load(configPath); err == nil {
				cfg = healed
				reach = client.Reachable(cfg)
			}
		}
	}
	step("reaching the control plane", reach,
		"Check the name resolves to the controller, that the port is open, and that the "+
			"console's certificate is published: deploy/publish-console-certificate.sh "+
			"on the controller.")

	// Everything the daemon does, in the order it does it. A ticket, the
	// policy document, the inventory that is this machine's check-in.
	api, err := client.New(cfg, version)
	step("Kerberos", err,
		"Usually the clock: a ticket is refused outside five minutes. Check "+
			"the clock and that krb5.conf names this realm.")
	if err != nil {
		return 1
	}
	defer api.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	document, err := api.Policy(ctx)
	step("fetching policy", err,
		"A 401 is the service principal or the keytab; a 404 means the "+
			"directory has no computer account for this machine.")
	if err == nil {
		fmt.Printf("        %d policy object(s), serial %s, refresh every %d minute(s)\n",
			len(document.AppliedGPOs), short(document.Serial), document.RefreshMinutes)
	}

	step("checking in", api.Inventory(ctx, inventory.Collect(ctx, apply.NewEnv(""))),
		"The console shows a machine as never seen until this succeeds.")

	queued, err := api.Tasks(ctx)
	step("collecting queued work", err, "")
	if err == nil {
		fmt.Printf("        %d task(s) waiting\n", len(queued))
	}

	fmt.Println()
	if failed {
		fmt.Println("Something above is why this machine is not reporting.")
		return 1
	}
	fmt.Println("This machine can reach the control plane and has checked in.")
	fmt.Println("Apply policy now with: odm-agent apply --force")
	return 0
}

// keytabHolds reports whether the keytab carries this machine's own account.
func keytabHolds(path, principal string) error {
	if _, err := os.Stat(path); err != nil {
		return err
	}
	kt, err := keytab.Load(path)
	if err != nil {
		return err
	}
	for _, entry := range kt.Entries {
		if strings.EqualFold(strings.Join(entry.Principal.Components, "/"), principal) {
			return nil
		}
	}
	return fmt.Errorf("holds no entry for %s", principal)
}

func short(serial string) string {
	if len(serial) > 12 {
		return serial[:12]
	}
	if serial == "" {
		return "none"
	}
	return serial
}

// odm-agent trust <certificate>: give this machine the console's certificate.
//
// A join without --ca-cert leaves the agent with only the system trust store,
// and until the domain has its own authority the console's certificate is
// self-signed — so every request failed verification and the machine reported
// nothing, with the console showing it as never seen. This installs the
// certificate and points the agent at it, which is the whole fix.
func runTrust(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: odm-agent trust <certificate file>")
		return 2
	}
	source := args[0]

	pem, err := os.ReadFile(source)
	if err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent trust:", err)
		return 1
	}
	block, _ := certpem.Decode(pem)
	if block == nil || block.Type != "CERTIFICATE" {
		fmt.Fprintf(os.Stderr, "odm-agent trust: %s is not a PEM certificate\n", source)
		return 1
	}
	if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent trust:", err)
		return 1
	}

	if err := os.MkdirAll(filepath.Dir(trustPath), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent trust:", err)
		return 1
	}
	if err := os.WriteFile(trustPath, pem, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent trust:", err)
		return 1
	}
	if err := config.SetCACert(config.DefaultPath, trustPath); err != nil {
		fmt.Fprintln(os.Stderr, "odm-agent trust:", err)
		return 1
	}
	fmt.Printf("Installed %s and pointed the agent at it.\n\n", trustPath)

	// Prove it works rather than claiming it does: the next thing the
	// operator would do is wonder whether that was enough.
	return runCheck(nil)
}

// Where a client keeps the console's certificate. The same path the domain
// join writes when it is given one, so trusting a certificate by hand and
// joining with --ca-cert leave the machine in the same state.
const trustPath = "/etc/odm/tls/api-ca.pem"
