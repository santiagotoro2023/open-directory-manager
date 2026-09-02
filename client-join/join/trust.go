package join

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"strings"
)

// The console's certificate, fetched from the domain rather than carried to
// the machine by hand.
//
// A machine has to verify the console before it can talk to it, and until the
// domain has a certificate authority of its own the console's certificate is
// self-signed — so nothing in the system trust store vouches for it. Passing
// it with --ca-cert worked and was forgotten every time, and a join that
// forgot it produced a machine that reported nothing with the reason visible
// nowhere.
//
// It comes from SYSVOL, which is where Active Directory has always
// distributed this sort of thing. What makes reading it safe is that the
// transfer is Kerberos-authenticated with mandatory signing: the controller
// proves itself with the KDC, not with the certificate being fetched, so
// there is no circle to break and nothing to take on trust.
const sysvolAnchor = "odm/api-ca.pem"

// FetchTrustAnchor returns the path to a certificate this machine can verify
// the console with, fetching it from the domain when it was not supplied.
//
// The machine account is used, so this runs after the join: it is the identity
// the agent will use afterwards, and if it cannot read SYSVOL the agent could
// not have worked either.
func FetchTrustAnchor(ctx context.Context, options Options, controller string, env Env) (string, error) {
	if options.CACert != "" {
		return options.CACert, nil
	}
	if options.DryRun || env.Run == nil {
		return "", nil
	}
	if _, err := env.Run.Run(ctx, "sh", "-c", "command -v smbclient"); err != nil {
		return "", fmt.Errorf("smbclient is not installed, so the console certificate " +
			"cannot be fetched from the domain")
	}

	// A controller by name, never the domain name: Kerberos authenticates to
	// a host, and there is no cifs/<domain> principal to ask for.
	server := controller
	if options.Server != "" {
		server = options.Server
	}
	if server == "" {
		if found, err := DiscoverControllers(ctx, options.Domain); err == nil && len(found) > 0 {
			server = found[0].Host
		}
	}
	if server == "" {
		return "", fmt.Errorf("no domain controller to read the console certificate from")
	}

	// Inside the share the domain has a directory of its own, named after
	// itself in lower case, which is where Samba puts policy too.
	remote := strings.ToLower(options.Domain) + "/" + sysvolAnchor
	local := env.Path(CACertPath + ".fetched")
	if err := os.MkdirAll(dir(local), 0o755); err != nil {
		return "", err
	}
	defer os.Remove(local)

	out, err := env.Run.Run(ctx, "smbclient", "//"+server+"/sysvol",
		"--machine-pass", "--use-kerberos=required",
		"-c", fmt.Sprintf("get \"%s\" \"%s\"", remote, local))
	if err != nil {
		return "", fmt.Errorf("reading %s from //%s/sysvol: %w: %s",
			remote, server, err, strings.TrimSpace(lastLine(out)))
	}

	// What arrived has to be a certificate before this machine trusts it.
	body, err := os.ReadFile(local)
	if err != nil {
		return "", err
	}
	block, _ := pem.Decode(body)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", fmt.Errorf("what SYSVOL holds is not a PEM certificate")
	}
	if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		return "", fmt.Errorf("the certificate in SYSVOL will not parse: %w", err)
	}
	if err := env.WriteFile(CACertPath, string(body), 0o644); err != nil {
		return "", err
	}
	return CACertPath, nil
}

func lastLine(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	return lines[len(lines)-1]
}
