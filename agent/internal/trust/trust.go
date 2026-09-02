// Package trust keeps this machine able to verify the control plane.
//
// The console's certificate is self-signed until the domain has a certificate
// authority of its own, so nothing in the system trust store vouches for it
// and the machine has to hold a copy. Carrying that copy to every machine by
// hand is what made a joined machine reporting nothing the normal outcome of a
// normal join, so the domain publishes it: SYSVOL holds it, exactly as Active
// Directory has always distributed this sort of thing.
//
// Reading it there is safe because the transfer is Kerberos-authenticated with
// mandatory signing — the controller proves itself with the KDC, not with the
// certificate being fetched, so there is no circle to break.
//
// The agent fetches it again by itself when verification starts failing, which
// is what happens when the console's certificate is replaced: a domain that
// issues itself a real certificate would otherwise silence every agent in it.
package trust

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"odm.example.org/agent/internal/apply"
	"odm.example.org/agent/internal/config"
)

// Path is where a machine keeps the console's certificate. The same path the
// domain join writes, so a machine that healed itself and one that was joined
// with --ca-cert are in the same state.
const Path = "/etc/odm/tls/api-ca.pem"

// Anchor is the file inside the domain's SYSVOL directory.
const Anchor = "odm/api-ca.pem"

// Untrusted reports whether this error is the control plane's certificate
// failing to verify, rather than anything else that can go wrong.
func Untrusted(err error) bool {
	if err == nil {
		return false
	}
	var verification *tls.CertificateVerificationError
	var authority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	return errors.As(err, &verification) ||
		errors.As(err, &authority) ||
		errors.As(err, &hostname)
}

// FromDomain fetches the certificate from SYSVOL as this machine and points
// the agent's configuration at it. Returns the path it wrote.
func FromDomain(
	ctx context.Context, cfg config.Config, configPath string, env apply.Env,
) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	if _, err := os.Stat(env.Path("/usr/bin/smbclient")); err != nil {
		return "", fmt.Errorf("smbclient is not installed, so the console certificate " +
			"cannot be fetched from the domain")
	}

	// The realm is the domain, and the domain resolves to its controllers:
	// whichever answers holds the same SYSVOL.
	domain := strings.ToLower(cfg.Realm)
	if domain == "" {
		return "", fmt.Errorf("no realm in %s", configPath)
	}
	remote := domain + "/" + Anchor
	staged := env.Path(Path + ".fetched")
	if err := os.MkdirAll(filepath.Dir(staged), 0o755); err != nil {
		return "", err
	}
	defer os.Remove(staged)

	out, err := env.Run.Run(ctx, "smbclient", "//"+domain+"/sysvol",
		"--machine-pass", "--use-kerberos=required",
		"-c", fmt.Sprintf("get \"%s\" \"%s\"", remote, staged))
	if err != nil {
		return "", fmt.Errorf("reading %s from //%s/sysvol: %w: %s", remote, domain, err,
			strings.TrimSpace(out))
	}

	body, err := os.ReadFile(staged)
	if err != nil {
		return "", err
	}
	if err := valid(body); err != nil {
		return "", err
	}
	if err := env.WriteFile(Path, string(body), 0o644, "root", "root"); err != nil {
		return "", err
	}
	if err := config.SetCACert(env.Path(configPath), Path); err != nil {
		return "", err
	}
	return Path, nil
}

// valid refuses anything that is not a certificate before the machine trusts
// it: this file decides who the agent will talk to.
func valid(body []byte) error {
	block, _ := pem.Decode(body)
	if block == nil || block.Type != "CERTIFICATE" {
		return fmt.Errorf("what SYSVOL holds is not a PEM certificate")
	}
	if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		return fmt.Errorf("the certificate in SYSVOL will not parse: %w", err)
	}
	return nil
}
