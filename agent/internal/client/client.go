// Package client talks to the ODM API as the machine itself.
//
// Authentication is SPNEGO with the keytab domain join already installed, so
// there is no agent credential to leak or rotate separately (CLAUDE.md §2).
package client

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jcmturner/gokrb5/v8/client"
	"github.com/jcmturner/gokrb5/v8/config"
	"github.com/jcmturner/gokrb5/v8/keytab"
	"github.com/jcmturner/gokrb5/v8/spnego"

	agentconfig "odm.example.org/agent/internal/config"
	"odm.example.org/agent/internal/enrol"
	"odm.example.org/agent/internal/inventory"
	"odm.example.org/agent/internal/policy"
	"odm.example.org/agent/internal/tasks"
)

type Client struct {
	base    string
	spn     string
	http    *spnego.Client
	krb     *client.Client
	version string
}

func New(cfg agentconfig.Config, version string) (*Client, error) {
	krb5conf, err := config.Load(cfg.Krb5Conf)
	if err != nil {
		return nil, fmt.Errorf("load %s: %w", cfg.Krb5Conf, err)
	}
	kt, err := keytab.Load(cfg.Keytab)
	if err != nil {
		return nil, fmt.Errorf("load keytab: %w", err)
	}

	principal, err := machinePrincipal()
	if err != nil {
		return nil, err
	}
	krb := client.NewWithKeytab(principal, cfg.Realm, kt, krb5conf, client.DisablePAFXFAST(true))

	transport, err := tlsTransport(cfg.CACert)
	if err != nil {
		return nil, err
	}
	httpClient := &http.Client{Timeout: 60 * time.Second, Transport: transport}

	return &Client{
		base:    strings.TrimSuffix(cfg.APIURL, "/"),
		spn:     cfg.ServicePrincipal,
		http:    spnego.NewClient(krb, httpClient, cfg.ServicePrincipal),
		krb:     krb,
		version: version,
	}, nil
}

func (c *Client) Close() {
	if c.krb != nil {
		c.krb.Destroy()
	}
}

// machinePrincipal derives the machine account name the way a domain join
// creates it: the short hostname, upper case, with a trailing dollar.
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

func tlsTransport(caCert string) (*http.Transport, error) {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if caCert != "" {
		pem, err := os.ReadFile(caCert)
		if err != nil {
			return nil, fmt.Errorf("read ca_cert: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("ca_cert contains no certificates")
		}
		tlsConfig.RootCAs = pool
	}
	return &http.Transport{
		TLSClientConfig:     tlsConfig,
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
		TLSHandshakeTimeout: 10 * time.Second,
	}, nil
}

// Policy fetches the machine's effective policy. Facts the directory cannot
// know — the running OS and the current addresses — are sent along so the
// API can evaluate item-level targeting against them.
func (c *Client) Policy(ctx context.Context) (*policy.Document, error) {
	query := url.Values{}
	query.Set("os", osRelease())
	for _, address := range localAddresses() {
		query.Add("ip", address)
	}
	return c.get(ctx, "/api/v1/agent/policy?"+query.Encode())
}

// UserPolicy fetches the policy that applies to one user on this machine.
func (c *Client) UserPolicy(ctx context.Context, username string) (*policy.Document, error) {
	query := url.Values{}
	query.Set("user", username)
	query.Set("os", osRelease())
	return c.get(ctx, "/api/v1/agent/user-policy?"+query.Encode())
}

func (c *Client) get(ctx context.Context, path string) (*policy.Document, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", path, response.Status)
	}
	document := &policy.Document{}
	if err := json.NewDecoder(response.Body).Decode(document); err != nil {
		return nil, fmt.Errorf("decode policy: %w", err)
	}
	return document, nil
}

// Report posts the Resultant Set of Policy back so an operator can see what
// actually happened rather than inferring it.
func (c *Client) Report(ctx context.Context, report policy.Report) error {
	report.AgentVersion = c.version
	body, err := json.Marshal(report)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.base+"/api/v1/agent/report", bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("report: %s", response.Status)
	}
	return nil
}

// osRelease produces the identifier item-level targeting matches against,
// e.g. "debian-13".
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
	id, version := fields["ID"], fields["VERSION_ID"]
	if id == "" {
		return ""
	}
	if version == "" {
		return id
	}
	return id + "-" + version
}

func localAddresses() []string {
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var out []string
	for _, address := range addresses {
		if network, ok := address.(*net.IPNet); ok && !network.IP.IsLoopback() {
			out = append(out, network.IP.String())
		}
	}
	return out
}

// Tasks claims whatever work the control plane has queued for this machine.
// An empty list is the normal case and is not an error.
func (c *Client) Tasks(ctx context.Context) ([]tasks.Task, error) {
	request, err := http.NewRequestWithContext(
		ctx, http.MethodGet, c.base+"/api/v1/agent/tasks", nil,
	)
	if err != nil {
		return nil, err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tasks: %s", response.Status)
	}
	var body struct {
		Tasks []tasks.Task `json:"tasks"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode tasks: %w", err)
	}
	return body.Tasks, nil
}

// TaskResult records how a task went. Reported even on failure, so a stuck
// install shows a reason in the console rather than staying "installing".
func (c *Client) TaskResult(ctx context.Context, result tasks.Result) error {
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.base+"/api/v1/agent/tasks/result", bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("task result: %s", response.Status)
	}
	return nil
}

// Inventory reports what the directory cannot know about this machine: its
// local accounts, who is on it, when it booted, what updates are waiting.
func (c *Client) Inventory(ctx context.Context, report inventory.Report) error {
	body, err := json.Marshal(report)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.base+"/api/v1/agent/inventory", bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("inventory: %s", response.Status)
	}
	return nil
}

// Certificate asks the control plane for one for this machine. The subject is
// not sent: it is named from the Kerberos identity this request carries.
func (c *Client) Certificate(
	ctx context.Context, request enrol.Request,
) (*enrol.Response, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	httpRequest, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.base+"/api/v1/agent/certificate", bytes.NewReader(body),
	)
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(httpRequest)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("certificate: %s", response.Status)
	}
	issued := &enrol.Response{}
	if err := json.NewDecoder(response.Body).Decode(issued); err != nil {
		return nil, fmt.Errorf("decode certificate: %w", err)
	}
	return issued, nil
}
