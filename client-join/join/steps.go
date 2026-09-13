package join

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Preflight refuses a join that is going to fail halfway through.
func Preflight(ctx context.Context, options Options, env Env) error {
	if env.Root == "" && os.Geteuid() != 0 {
		return fmt.Errorf("joining a domain requires root")
	}
	if options.DryRun || env.Run == nil {
		return nil
	}
	for _, tool := range []string{"net", "sssd", "hostnamectl"} {
		if _, err := env.Run.Run(ctx, "sh", "-c", "command -v "+tool); err != nil {
			return fmt.Errorf(
				"%s is not installed; install samba-common-bin and sssd-ad first", tool,
			)
		}
	}
	return nil
}

// StartServices makes the configuration written above take effect.
func StartServices(ctx context.Context, options Options, env Env) error {
	if options.DryRun || env.Run == nil {
		return nil
	}
	if _, err := env.Run.Run(ctx, "systemctl", "enable", "sssd"); err != nil {
		return fmt.Errorf("cannot enable sssd: %w", err)
	}
	if _, err := env.Run.Run(ctx, "systemctl", "restart", "sssd"); err != nil {
		return fmt.Errorf(
			"sssd did not start; check journalctl -u sssd: %w", err,
		)
	}
	return nil
}

// NetAdsJoin joins with a domain administrator credential. The password is
// fed on standard input so it never appears in a command line.
func NetAdsJoin(ctx context.Context, options Options, env Env) error {
	if options.DryRun || env.Run == nil {
		return nil
	}
	args := []string{"ads", "join", "-U", options.AdminUser}
	if options.OU != "" {
		args = append(args, "createcomputer="+options.OU)
	}
	if options.Server != "" {
		args = append(args, "-S", options.Server)
	}
	if _, err := env.Run.RunWithInput(ctx, options.Password+"\n", "net", args...); err != nil {
		return fmt.Errorf("the domain refused the join: %w", err)
	}

	// join registers HOST/ for this machine, because that is what a Windows
	// domain member needs: Windows' own Kerberos client and KDC quietly alias
	// every other service a Windows machine offers to its HOST/ ticket.
	// Linux's cifs.upcall carries no such aliasing — a sec=krb5 mount asks the
	// KDC for the literal principal "cifs/<server>" — so a file share on a
	// Samba member server joined the ordinary way is unreachable from any
	// Linux client until the account also carries that exact name. Best
	// effort and after the join itself: a share nobody can reach yet is a
	// smaller problem than a join this could otherwise fail over.
	addCifsSPN(ctx, options, env)

	if _, err := env.Run.Run(ctx, "net", "ads", "keytab", "create", "-P"); err != nil {
		return fmt.Errorf("the machine keytab could not be created: %w", err)
	}
	// keytab create only carries the principals the account had at the
	// moment it ran, which is before the cifs/ names above existed.
	addCifsKeytabEntries(ctx, options, env)
	return nil
}

func addCifsSPN(ctx context.Context, options Options, env Env) {
	for _, name := range []string{shortName(options.Hostname), options.Hostname} {
		_, _ = env.Run.Run(ctx, "net", "ads", "setspn", "add", "cifs/"+name, "-P")
	}
}

func addCifsKeytabEntries(ctx context.Context, options Options, env Env) {
	for _, name := range []string{shortName(options.Hostname), options.Hostname} {
		_, _ = env.Run.Run(ctx, "net", "ads", "keytab", "add", "cifs/"+name, "-P")
	}
}

// Enrolment is what the control plane returns for a redeemed token.
type Enrolment struct {
	Realm            string `json:"realm"`
	Domain           string `json:"domain"`
	ContainerDN      string `json:"container_dn"`
	KeytabBase64     string `json:"keytab"`
	ServicePrincipal string `json:"service_principal"`
	APIURL           string `json:"api_url"`
	RefreshMinutes   int    `json:"agent_refresh_minutes"`

	Keytab []byte `json:"-"`
}

// Redeem exchanges a one-time token for this machine's own keytab, so no
// domain administrator credential is ever typed on the client.
func Redeem(ctx context.Context, options Options) (*Enrolment, error) {
	payload, err := json.Marshal(map[string]string{
		"token":            options.OTP,
		"hostname":         options.Hostname,
		"operating_system": osRelease(),
	})
	if err != nil {
		return nil, err
	}

	client, err := httpClient(options.CACert)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, options.APIURL+"/api/v1/join/redeem", bytes.NewReader(payload),
	)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("cannot reach the control plane: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		var problem struct {
			Detail string `json:"detail"`
		}
		_ = json.NewDecoder(response.Body).Decode(&problem)
		if problem.Detail == "" {
			problem.Detail = response.Status
		}
		return nil, fmt.Errorf("enrolment refused: %s", problem.Detail)
	}

	enrolment := &Enrolment{}
	if err := json.NewDecoder(response.Body).Decode(enrolment); err != nil {
		return nil, fmt.Errorf("the control plane returned an unreadable response: %w", err)
	}
	keytab, err := base64.StdEncoding.DecodeString(enrolment.KeytabBase64)
	if err != nil {
		return nil, fmt.Errorf("the keytab could not be decoded: %w", err)
	}
	enrolment.Keytab = keytab
	return enrolment, nil
}

// DefaultContainer asks the control plane where a computer object lands when
// nothing about this join names one — the domain's own default, set once
// under Domain Controllers rather than typed as --ou on every machine.
//
// Unauthenticated: this machine has no credential of its own yet, only
// whatever admin credential is joining it, and asking costs nothing to get
// wrong — a console that cannot be reached, or that has never had a default
// set, is answered exactly as if --ou had simply been left off, which is
// what happened before this existed.
func DefaultContainer(ctx context.Context, options Options) (string, error) {
	client, err := httpClient(options.CACert)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodGet, options.APIURL+"/api/v1/join/default-container", nil,
	)
	if err != nil {
		return "", err
	}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("cannot reach the control plane: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the control plane refused: %s", response.Status)
	}
	var body struct {
		DefaultComputerContainer string `json:"default_computer_container"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("the control plane returned an unreadable response: %w", err)
	}
	return body.DefaultComputerContainer, nil
}

func httpClient(caCert string) (*http.Client, error) {
	config := &tls.Config{MinVersion: tls.VersionTLS12}
	if caCert != "" {
		pem, err := os.ReadFile(caCert)
		if err != nil {
			return nil, fmt.Errorf("cannot read the CA certificate: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("the CA certificate file contains no certificates")
		}
		config.RootCAs = pool
	}
	return &http.Client{
		Timeout:   60 * time.Second,
		Transport: &http.Transport{TLSClientConfig: config},
	}, nil
}

func osRelease() string {
	raw, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return ""
	}
	fields := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok {
			fields[key] = strings.Trim(value, `"`)
		}
	}
	if fields["ID"] == "" {
		return ""
	}
	if fields["VERSION_ID"] == "" {
		return fields["ID"]
	}
	return fields["ID"] + "-" + fields["VERSION_ID"]
}

// ConsoleTrusted reports whether this machine can verify the control plane's
// certificate with what it now holds.
//
// Until the domain has a certificate authority of its own the console's
// certificate is self-signed, so a machine that was not given it verifies
// against the system trust store and fails — every policy fetch, every
// check-in. The join used to finish without noticing, and the machine then sat
// in the console as one that had never reported.
func ConsoleTrusted(ctx context.Context, options Options, env Env) bool {
	if options.DryRun {
		return true
	}
	anchor := options.CACert
	if anchor == "" {
		// What the join writes when it is given one, and what
		// "odm-agent trust" writes afterwards.
		if _, err := os.Stat(env.Path(CACertPath)); err == nil {
			anchor = env.Path(CACertPath)
		}
	}
	client, err := httpClient(anchor)
	if err != nil {
		return false
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodGet, options.APIURL+"/api/v1/healthz", nil,
	)
	if err != nil {
		return false
	}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK
}
