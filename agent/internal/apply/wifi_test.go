package apply

import (
	"context"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

func TestAnEapNetworkIsTheMachineCertificateAndTheDomainAuthority(t *testing.T) {
	body, err := nmKeyfile(policy.WifiNetwork{
		SSID: "Corp", Security: "wpa-eap", EAP: "tls", CertificatePath: "/etc/ssl/odm",
		ServerName: "radius.corp.example.internal", Autoconnect: true, Priority: 10,
	}, "ws01.corp.example.internal")
	if err != nil {
		t.Fatal(err)
	}
	for _, wanted := range []string{
		"[connection]", "id=odm-Corp", "type=wifi", "autoconnect=true", "autoconnect-priority=10",
		"ssid=Corp", "key-mgmt=wpa-eap", "eap=tls;", "identity=host/ws01.corp.example.internal",
		"client-cert=/etc/ssl/odm/client.crt", "private-key=/etc/ssl/odm/client.key",
		"ca-cert=" + domainAuthorityAnchor, "domain-suffix-match=radius.corp.example.internal",
	} {
		if !strings.Contains(body, wanted) {
			t.Errorf("missing %q in:\n%s", wanted, body)
		}
	}
	if strings.Contains(body, "psk=") {
		t.Error("an 802.1X network carries no pre-shared key")
	}
}

func TestAPreSharedKeyNetworkNeedsAKeyAndAHiddenOneSaysSo(t *testing.T) {
	if _, err := nmKeyfile(policy.WifiNetwork{SSID: "Guest", Security: "wpa-psk", PSK: "short"}, "h"); err == nil {
		t.Error("a five-character key was accepted")
	}
	body, err := nmKeyfile(policy.WifiNetwork{SSID: "Guest", Security: "wpa-psk", PSK: "correct horse", Hidden: true}, "h")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, "psk=correct horse") || !strings.Contains(body, "hidden=true") {
		t.Errorf("wrong keyfile:\n%s", body)
	}
}

func TestWifiIsSkippedWhereThereIsNoNetworkManager(t *testing.T) {
	env, _ := testEnv(t)
	results := applyWifi(context.Background(), policy.Settings{
		WifiNetworks: []policy.WifiNetwork{{SSID: "Corp", Security: "wpa-eap"}},
	}, env)
	if len(results) != 1 || results[0].Status != "skipped" {
		t.Fatalf("expected one skipped result, got %+v", results)
	}
}

func TestWifiKeyfilesAreRootOnlyAndReloaded(t *testing.T) {
	env, runner := testEnv(t)
	write(t, env, nmConnectionDir+"/.keep", "")
	results := applyWifi(context.Background(), policy.Settings{
		WifiNetworks: []policy.WifiNetwork{{SSID: "Corp Wi-Fi", Security: "open", Autoconnect: true}},
	}, env)
	if len(results) == 0 || results[0].Status != "success" {
		t.Fatalf("got %+v", results)
	}
	body := read(t, env, nmConnectionDir+"/odm-Corp_Wi-Fi.nmconnection")
	if !strings.Contains(body, "ssid=Corp Wi-Fi") {
		t.Errorf("the SSID is not in the keyfile:\n%s", body)
	}
	if !runner.ran("nmcli", "reload") {
		t.Error("NetworkManager was never told to reload")
	}
}
