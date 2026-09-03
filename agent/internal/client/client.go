// Package client talks to the ODM API as the machine itself.
//
// Authentication is SPNEGO with the keytab domain join already installed, so
// there is no agent credential to leak or rotate separately (CLAUDE.md §2).
package client

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
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

// Reachable answers whether the control plane is there and its certificate is
// one this machine trusts, with no Kerberos involved. Split out because it is
// the first thing to fail on a fresh join — a name that does not resolve, a
// port nothing listens on, a certificate the machine was not given — and each
// of those reaches the operator as "the agent does not report" otherwise.
func Reachable(cfg agentconfig.Config) error {
	transport, err := tlsTransport(cfg.CACert)
	if err != nil {
		return err
	}
	httpClient := &http.Client{Timeout: 15 * time.Second, Transport: transport}
	url := strings.TrimSuffix(cfg.APIURL, "/") + "/api/v1/healthz"
	response, err := httpClient.Get(url)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", url, response.Status)
	}
	return nil
}

// MachinePrincipal is the account this machine authenticates as: the name a
// domain join created, which is what has to be in the keytab.
func MachinePrincipal() (string, error) { return machinePrincipal() }

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
		return nil, fmt.Errorf("%s: %s", path, why(response))
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
		return fmt.Errorf("report: %s", why(response))
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
	return c.tasks(ctx, 0)
}

// WaitForTasks asks for this machine's work and lets the control plane hold
// the request open until there is some, so an action an operator just clicked
// runs now rather than at the next poll.
func (c *Client) WaitForTasks(ctx context.Context, wait time.Duration) ([]tasks.Task, error) {
	return c.tasks(ctx, wait)
}

func (c *Client) tasks(ctx context.Context, wait time.Duration) ([]tasks.Task, error) {
	request, err := http.NewRequestWithContext(
		ctx, http.MethodGet, c.base+"/api/v1/agent/tasks"+waitQuery(wait), nil,
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
		return nil, fmt.Errorf("tasks: %s", why(response))
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
// TaskProgress reports what a long task has printed so far, so the console can
// show a machine's own output instead of the word "installing".
func (c *Client) TaskProgress(ctx context.Context, id, output string) error {
	body, err := json.Marshal(map[string]string{"id": id, "output": output})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.base+"/api/v1/agent/tasks/progress", bytes.NewReader(body),
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
	if response.StatusCode >= 300 {
		return fmt.Errorf("task progress: %s", why(response))
	}
	return nil
}

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
		return fmt.Errorf("task result: %s", why(response))
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
		return fmt.Errorf("inventory: %s", why(response))
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

// waitQuery is empty for a plain read; the control plane caps what it accepts.
func waitQuery(wait time.Duration) string {
	if wait <= 0 {
		return ""
	}
	return "?wait=" + strconv.Itoa(int(wait.Seconds()))
}

// why is the status and whatever the control plane said about it.
//
// "422 Unprocessable Content" on its own is a dead end: the body names the
// field it refused and why, and an operator reading the agent's journal
// should not have to go and reproduce the request to see it.
func why(response *http.Response) string {
	body, err := io.ReadAll(io.LimitReader(response.Body, 600))
	if err != nil || len(body) == 0 {
		return response.Status
	}
	return response.Status + ": " + strings.TrimSpace(string(body))
}

// DownloadAgent fetches the agent binary this console hands out, writing it
// beside the destination so the move into place is atomic. Returns the
// temporary file's path and the version the console said it was.
//
// A 60-second client timeout covers a policy request and is not enough for a
// 30 MB binary over a slow link, so this one gets its own deadline.
func (c *Client) DownloadAgent(ctx context.Context, beside string) (path, version string, err error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/v1/agent/binary", nil)
	if err != nil {
		return "", "", err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return "", "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("agent binary: %s", why(response))
	}

	// In the destination's own directory: a rename across filesystems is not
	// atomic and /tmp is very often one.
	file, err := os.CreateTemp(filepath.Dir(beside), ".odm-agent-*")
	if err != nil {
		return "", "", err
	}
	digest := sha256.New()
	if _, err := io.Copy(io.MultiWriter(file, digest), response.Body); err != nil {
		file.Close()
		os.Remove(file.Name())
		return "", "", fmt.Errorf("downloading the agent: %w", err)
	}
	if err := file.Close(); err != nil {
		os.Remove(file.Name())
		return "", "", err
	}

	// What arrived is what the console said it was sending. This catches a
	// truncated transfer, which otherwise installs a binary that will not run
	// and takes the machine's agent with it.
	if want := response.Header.Get("X-ODM-Agent-Sha256"); want != "" {
		if got := hex.EncodeToString(digest.Sum(nil)); got != want {
			os.Remove(file.Name())
			return "", "", fmt.Errorf("the agent that arrived is not the one offered")
		}
	}
	if err := os.Chmod(file.Name(), 0o755); err != nil {
		os.Remove(file.Name())
		return "", "", err
	}
	return file.Name(), response.Header.Get("X-ODM-Agent-Version"), nil
}
