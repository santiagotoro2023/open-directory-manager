// Package config reads the agent's own settings, written by the domain-join
// client. Everything security-relevant (the realm, the keytab) comes from the
// machine's existing Kerberos configuration, not from a second credential
// store.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const DefaultPath = "/etc/odm/agent.json"

type Config struct {
	// APIURL is the ODM control plane, https only.
	APIURL string `json:"api_url"`
	// SPN of the API service, e.g. HTTP/odm.corp.example.internal
	ServicePrincipal string `json:"service_principal"`
	// Keytab holding the machine's own credentials, from domain join.
	Keytab string `json:"keytab"`
	// Realm the machine belongs to.
	Realm string `json:"realm"`
	// Krb5Conf is the system Kerberos configuration.
	Krb5Conf string `json:"krb5_conf"`
	// CACert validates the API's TLS certificate.
	CACert string `json:"ca_cert"`
	// RefreshMinutes is the fallback interval when policy does not set one.
	RefreshMinutes int `json:"refresh_minutes"`
}

func Load(path string) (Config, error) {
	if path == "" {
		path = DefaultPath
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read %s: %w", path, err)
	}
	config := Config{Krb5Conf: "/etc/krb5.conf", RefreshMinutes: 15}
	if err := json.Unmarshal(raw, &config); err != nil {
		return Config{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return config, config.Validate()
}

func (c Config) Validate() error {
	switch {
	case !strings.HasPrefix(c.APIURL, "https://"):
		// CLAUDE.md §6: no plaintext transport, ever.
		return fmt.Errorf("api_url must be https")
	case c.ServicePrincipal == "":
		return fmt.Errorf("service_principal is required")
	case c.Keytab == "":
		return fmt.Errorf("keytab is required")
	case c.Realm == "":
		return fmt.Errorf("realm is required")
	}
	return nil
}

// SetCACert points the agent at a certificate it should verify the control
// plane with, leaving the rest of the file alone.
//
// A join that was not given the console's certificate wrote no ca_cert, and
// the machine then failed every request against the system trust store —
// silently, from the operator's side. This is how that is corrected without
// re-joining the domain.
func SetCACert(path, caCert string) error {
	if path == "" {
		path = DefaultPath
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	fields["ca_cert"] = caCert
	body, err := json.MarshalIndent(fields, "", "  ")
	if err != nil {
		return err
	}
	// Same permissions the join writes: the file names a keytab and a realm,
	// and is read by a service running as root.
	return os.WriteFile(path, append(body, '\n'), 0o640)
}
