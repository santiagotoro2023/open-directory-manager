package join

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDefaultContainerReadsWhatTheControlPlaneOffers(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/join/default-container" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(
			`{"default_computer_container":"OU=Workstations,DC=corp,DC=example,DC=internal"}`,
		))
	}))
	defer server.Close()

	found, err := DefaultContainer(context.Background(), Options{APIURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if found != "OU=Workstations,DC=corp,DC=example,DC=internal" {
		t.Errorf("got %q", found)
	}
}

// A domain that has never set one answers with an empty string, which a
// caller must tell apart from a failure: one falls back to Samba's own
// default silently, the other is worth a line of output.
func TestDefaultContainerIsEmptyWhenNoneIsSet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"default_computer_container":""}`))
	}))
	defer server.Close()

	found, err := DefaultContainer(context.Background(), Options{APIURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if found != "" {
		t.Errorf("got %q, wanted empty", found)
	}
}

// A console that cannot be reached, or that refuses, must not fail a join —
// it is answered exactly as if --ou had simply been left off.
func TestDefaultContainerFailsClosedOnAnUnreachableConsole(t *testing.T) {
	if _, err := DefaultContainer(
		context.Background(), Options{APIURL: "https://127.0.0.1:1"},
	); err == nil {
		t.Fatal("expected an error from a console nothing is listening on")
	}
}

func TestDefaultContainerFailsClosedOnARefusal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	if _, err := DefaultContainer(
		context.Background(), Options{APIURL: server.URL},
	); err == nil {
		t.Fatal("expected an error from a 500")
	}
}
