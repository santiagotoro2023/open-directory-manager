// Package enrol keeps this machine's certificates current.
//
// The machine asks for "a certificate"; the control plane names it from the
// Kerberos identity that asked. Nothing here chooses a subject, which is what
// stops a compromised agent obtaining a certificate for anything but itself.
package enrol

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"odm.example.org/agent/internal/apply"
	"odm.example.org/agent/internal/policy"
)

// Request is what the agent sends. Deliberately small: everything that
// identifies the certificate is decided server-side.
type Request struct {
	Profile       string `json:"profile"`
	ValidityDays  int    `json:"validity_days"`
	CurrentSerial string `json:"current_serial,omitempty"`
}

// Response is what comes back.
type Response struct {
	Unchanged      bool   `json:"unchanged"`
	Serial         string `json:"serial"`
	Subject        string `json:"subject"`
	NotAfter       string `json:"not_after"`
	CertificatePEM string `json:"certificate_pem"`
	PrivateKeyPEM  string `json:"private_key_pem"`
	CAPEM          string `json:"ca_pem"`
}

// Issuer is what fetches a certificate. An interface so the renewal decision
// can be tested without a control plane.
type Issuer interface {
	Certificate(ctx context.Context, request Request) (*Response, error)
}

// Apply brings every certificate the policy asks for up to date.
func Apply(
	ctx context.Context, settings policy.Settings, env apply.Env, issuer Issuer,
) []policy.Result {
	if len(settings.CertificateEnrolment) == 0 {
		return nil
	}
	results := []policy.Result{}
	for _, wanted := range settings.CertificateEnrolment {
		results = append(results, one(ctx, wanted, env, issuer))
	}
	return results
}

func one(
	ctx context.Context, wanted policy.CertificateEnrolment, env apply.Env, issuer Issuer,
) policy.Result {
	setting := "certificate:" + wanted.Profile
	if !strings.HasPrefix(wanted.Path, "/") || strings.Contains(wanted.Path, "..") {
		return policy.Result{Setting: setting, Status: "failed", Reason: "invalid path"}
	}

	certPath := filepath.Join(wanted.Path, wanted.Profile+".crt")
	keyPath := filepath.Join(wanted.Path, wanted.Profile+".key")
	caPath := filepath.Join(wanted.Path, "ca.crt")

	renewAfter := wanted.RenewBeforeDays
	if renewAfter <= 0 {
		renewAfter = 30
	}
	current, serial := Existing(env.Path(certPath))
	if current != nil && !DueForRenewal(current, renewAfter, time.Now()) {
		return policy.Result{
			Setting: setting,
			Status:  "unchanged",
			Reason:  "valid until " + current.NotAfter.Format(time.DateOnly),
		}
	}

	validity := wanted.ValidityDays
	if validity <= 0 {
		validity = 365
	}
	response, err := issuer.Certificate(ctx, Request{
		Profile:       wanted.Profile,
		ValidityDays:  validity,
		CurrentSerial: serial,
	})
	if err != nil {
		return policy.Fail(setting, err)
	}
	if response.Unchanged {
		return policy.Result{Setting: setting, Status: "unchanged", Reason: "already current"}
	}

	if err := os.MkdirAll(env.Path(wanted.Path), 0o755); err != nil {
		return policy.Fail(setting, err)
	}
	// The key is this machine's identity: nobody but root reads it.
	if err := env.WriteFile(keyPath, response.PrivateKeyPEM, 0o600, "root", "root"); err != nil {
		return policy.Fail(setting, err)
	}
	if err := env.WriteFile(certPath, response.CertificatePEM, 0o644, "root", "root"); err != nil {
		return policy.Fail(setting, err)
	}
	if response.CAPEM != "" {
		if err := env.WriteFile(caPath, response.CAPEM, 0o644, "root", "root"); err != nil {
			return policy.Fail(setting, err)
		}
	}
	return policy.Result{
		Setting: setting,
		Status:  "applied",
		Reason:  fmt.Sprintf("%s, serial %s", response.Subject, response.Serial),
	}
}

// Existing reads the certificate already on disk, if there is one, and its
// serial as the control plane records it.
func Existing(path string) (*x509.Certificate, string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, ""
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, ""
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, ""
	}
	return certificate, fmt.Sprintf("%X", certificate.SerialNumber)
}

// DueForRenewal reports whether a certificate is close enough to expiry to
// replace. Exported so the boundary can be tested without waiting a year.
func DueForRenewal(certificate *x509.Certificate, beforeDays int, now time.Time) bool {
	if now.After(certificate.NotAfter) {
		return true
	}
	return certificate.NotAfter.Sub(now) <= time.Duration(beforeDays)*24*time.Hour
}
