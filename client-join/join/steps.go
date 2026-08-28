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
	if _, err := env.Run.Run(ctx, "net", "ads", "keytab", "create", "-P"); err != nil {
		return fmt.Errorf("the machine keytab could not be created: %w", err)
	}
	return nil
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
