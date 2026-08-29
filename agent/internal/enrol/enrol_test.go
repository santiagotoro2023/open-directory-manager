package enrol

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	"odm.example.org/agent/internal/apply"
	"odm.example.org/agent/internal/policy"
)

func certificate(t *testing.T, notAfter time.Time) (string, *x509.Certificate) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(4242),
		Subject:      pkix.Name{CommonName: "ws-014.corp.example.internal"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     notAfter,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), parsed
}

type recordingIssuer struct {
	requests []Request
	response *Response
	failWith error
}

func (i *recordingIssuer) Certificate(_ context.Context, request Request) (*Response, error) {
	i.requests = append(i.requests, request)
	if i.failWith != nil {
		return nil, i.failWith
	}
	return i.response, nil
}

func testEnv(t *testing.T) apply.Env {
	t.Helper()
	return apply.NewEnv(t.TempDir())
}

func wanted() policy.Settings {
	return policy.Settings{CertificateEnrolment: []policy.CertificateEnrolment{{
		Profile:         "server",
		Path:            "/etc/ssl/odm",
		ValidityDays:    365,
		RenewBeforeDays: 30,
	}}}
}

func TestAMachineWithNoCertificateGetsOne(t *testing.T) {
	env := testEnv(t)
	pemBody, _ := certificate(t, time.Now().Add(365*24*time.Hour))
	issuer := &recordingIssuer{response: &Response{
		Serial:         "4242",
		Subject:        "CN=ws-014.corp.example.internal",
		CertificatePEM: pemBody,
		PrivateKeyPEM:  "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
		CAPEM:          "-----BEGIN CERTIFICATE-----\ny\n-----END CERTIFICATE-----\n",
	}}

	results := Apply(context.Background(), wanted(), env, issuer)

	if len(results) != 1 || results[0].Status != "applied" {
		t.Fatalf("expected one applied result, got %+v", results)
	}
	// The key is the machine's identity; nobody but root may read it.
	info, err := os.Stat(env.Path(filepath.Join("/etc/ssl/odm", "server.key")))
	if err != nil {
		t.Fatalf("the key was not written: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("expected 0600 on the key, got %o", mode)
	}
	for _, name := range []string{"server.crt", "ca.crt"} {
		if _, err := os.Stat(env.Path(filepath.Join("/etc/ssl/odm", name))); err != nil {
			t.Errorf("%s was not written: %v", name, err)
		}
	}
}

func TestTheRequestNeverNamesASubject(t *testing.T) {
	// A request that could name a subject would be one that could ask for
	// anyone's certificate. The name is decided by whoever answers.
	env := testEnv(t)
	pemBody, _ := certificate(t, time.Now().Add(365*24*time.Hour))
	issuer := &recordingIssuer{response: &Response{CertificatePEM: pemBody, PrivateKeyPEM: "k"}}

	Apply(context.Background(), wanted(), env, issuer)

	if len(issuer.requests) != 1 {
		t.Fatalf("expected one request, got %d", len(issuer.requests))
	}
	request := issuer.requests[0]
	if request.Profile != "server" || request.ValidityDays != 365 {
		t.Errorf("unexpected request: %+v", request)
	}
}

func TestACurrentCertificateIsNotReissued(t *testing.T) {
	env := testEnv(t)
	pemBody, _ := certificate(t, time.Now().Add(200*24*time.Hour))
	path := env.Path("/etc/ssl/odm/server.crt")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(pemBody), 0o644); err != nil {
		t.Fatal(err)
	}
	issuer := &recordingIssuer{}

	results := Apply(context.Background(), wanted(), env, issuer)

	if len(issuer.requests) != 0 {
		t.Fatalf("a valid certificate was reissued anyway: %+v", issuer.requests)
	}
	if results[0].Status != "unchanged" {
		t.Errorf("expected unchanged, got %+v", results[0])
	}
}

func TestACertificateInsideTheRenewalWindowIsReplaced(t *testing.T) {
	env := testEnv(t)
	// Twenty days left, renewed at thirty.
	pemBody, _ := certificate(t, time.Now().Add(20*24*time.Hour))
	path := env.Path("/etc/ssl/odm/server.crt")
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	_ = os.WriteFile(path, []byte(pemBody), 0o644)

	fresh, _ := certificate(t, time.Now().Add(365*24*time.Hour))
	issuer := &recordingIssuer{response: &Response{CertificatePEM: fresh, PrivateKeyPEM: "k"}}

	Apply(context.Background(), wanted(), env, issuer)

	if len(issuer.requests) != 1 {
		t.Fatal("a certificate inside its renewal window was not replaced")
	}
	// The serial it holds is sent, so the control plane can say "unchanged"
	// rather than issuing a second one.
	if issuer.requests[0].CurrentSerial == "" {
		t.Error("the current serial was not sent")
	}
}

func TestAnExpiredCertificateIsAlwaysDue(t *testing.T) {
	_, expired := certificate(t, time.Now().Add(-time.Hour))
	if !DueForRenewal(expired, 30, time.Now()) {
		t.Error("an expired certificate is not due for renewal")
	}
}

func TestAPathOutsideTheFilesystemIsRefused(t *testing.T) {
	env := testEnv(t)
	issuer := &recordingIssuer{}
	settings := policy.Settings{CertificateEnrolment: []policy.CertificateEnrolment{
		{Profile: "server", Path: "/etc/ssl/../../root"},
		{Profile: "client", Path: "relative/path"},
	}}

	results := Apply(context.Background(), settings, env, issuer)

	for _, result := range results {
		if result.Status != "failed" {
			t.Errorf("a bad path was accepted: %+v", result)
		}
	}
	if len(issuer.requests) != 0 {
		t.Error("a certificate was requested for a path that was refused")
	}
}

func TestAFailedIssueIsReportedRatherThanLosingTheOldCertificate(t *testing.T) {
	env := testEnv(t)
	pemBody, _ := certificate(t, time.Now().Add(5*24*time.Hour))
	path := env.Path("/etc/ssl/odm/server.crt")
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	_ = os.WriteFile(path, []byte(pemBody), 0o644)

	issuer := &recordingIssuer{failWith: context.DeadlineExceeded}
	results := Apply(context.Background(), wanted(), env, issuer)

	if results[0].Status != "failed" {
		t.Errorf("expected a failure to be reported, got %+v", results[0])
	}
	// The machine keeps working with what it has until a new one arrives.
	if body, err := os.ReadFile(path); err != nil || string(body) != pemBody {
		t.Error("the existing certificate was lost when renewal failed")
	}
}
