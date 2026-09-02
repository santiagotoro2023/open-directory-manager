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
	"net"
	"net/url"
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

	// A controller by name, never the domain name. Kerberos authenticates to
	// a host, and there is no cifs/<domain> principal: asking for one failed
	// with NT_STATUS_INVALID_PARAMETER before any share was ever opened.
	servers := controllers(ctx, domain, cfg.APIURL)
	if len(servers) == 0 {
		return "", fmt.Errorf("no domain controller found for %s: no _ldap._tcp service "+
			"records and nothing to fall back to", domain)
	}

	var last error
	for _, server := range servers {
		out, err := fetch(ctx, env, server, remote, staged)
		if err == nil {
			last = nil
			break
		}
		last = fmt.Errorf("reading %s from //%s/sysvol: %w: %s", remote, server, err,
			strings.TrimSpace(out))
	}
	if last != nil {
		return "", last
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

// fetch copies one file out of a controller's SYSVOL as this machine.
//
// Two ways to be this machine, because both fail on their own often enough:
// the password domain join stored, and the keytab. A machine whose secrets
// database smbclient will not read still has the keytab the agent
// authenticates with everywhere else.
func fetch(ctx context.Context, env apply.Env, server, remote, staged string) (string, error) {
	share := "//" + server + "/sysvol"
	command := fmt.Sprintf("get %q %q", remote, staged)

	out, err := env.Run.Run(ctx, "smbclient", share,
		"--machine-pass", "--use-kerberos=required", "-c", command)
	if err == nil {
		return out, nil
	}

	// A ticket of our own, from the keytab, in a ccache nothing else uses.
	principal, perr := machinePrincipal()
	if perr != nil {
		return out, err
	}
	ccache := "/tmp/odm-agent-trust.ccache"
	if _, kerr := env.Run.Run(ctx, "kinit", "-k", "-c", "FILE:"+env.Path(ccache),
		principal); kerr != nil {
		return out, err
	}
	defer os.Remove(env.Path(ccache))

	// Through a shell only to carry KRB5CCNAME: every value here is either a
	// constant or a name this machine wrote, and each is quoted.
	shell := fmt.Sprintf("KRB5CCNAME=FILE:%s smbclient %s --use-kerberos=required -c %s",
		shellQuote(env.Path(ccache)), shellQuote(share), shellQuote(command))
	return env.Run.Run(ctx, "sh", "-c", shell)
}

// controllers is where to ask, in order: what the domain advertises, and the
// control plane itself, which on a single-controller domain is the same
// machine and is right more often than not.
func controllers(ctx context.Context, domain, apiURL string) []string {
	var found []string
	if _, records, err := net.DefaultResolver.LookupSRV(
		ctx, "ldap", "tcp", "dc._msdcs."+domain,
	); err == nil {
		for _, record := range records {
			found = append(found, strings.TrimSuffix(record.Target, "."))
		}
	}
	if host := apiHost(apiURL); host != "" && !contains(found, host) {
		found = append(found, host)
	}
	return found
}

func apiHost(apiURL string) string {
	parsed, err := url.Parse(apiURL)
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}

func contains(haystack []string, needle string) bool {
	for _, candidate := range haystack {
		if strings.EqualFold(candidate, needle) {
			return true
		}
	}
	return false
}

// machinePrincipal is this machine's own account, the way a domain join
// creates it.
func machinePrincipal() (string, error) {
	host, err := os.Hostname()
	if err != nil {
		return "", err
	}
	short, _, _ := strings.Cut(host, ".")
	if short == "" {
		return "", fmt.Errorf("cannot determine hostname")
	}
	return strings.ToUpper(short) + "$", nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
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
