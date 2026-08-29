package tasks

import (
	"context"
	"strings"
	"testing"
)

func TestATunnelCarriesEveryEnabledPeerAndRoutesBehindIt(t *testing.T) {
	body, err := RenderServer(map[string]any{
		"name":        "homeoffice",
		"address":     "10.99.0.1/24",
		"listen_port": float64(51820),
		"private_key": "c2VydmVyLXByaXZhdGUta2V5LWJhc2U2NA==",
		"peers": []any{
			map[string]any{
				"name":        "ada-laptop",
				"public_key":  "cGVlci1vbmUtcHVibGljLWtleS1iYXNlNjQ=",
				"allowed_ips": []any{"10.99.0.2/32"},
			},
			map[string]any{
				"name":        "ws-014",
				"public_key":  "cGVlci10d28tcHVibGljLWtleS1iYXNlNjQ=",
				"allowed_ips": []any{"10.99.0.3/32"},
			},
		},
	}, "eth0")
	if err != nil {
		t.Fatal(err)
	}

	if strings.Count(body, "[Peer]") != 2 {
		t.Errorf("expected two peers:\n%s", body)
	}
	if !strings.Contains(body, "ListenPort = 51820") {
		t.Errorf("no listen port:\n%s", body)
	}
	// Without the masquerade a peer reaches the server and nothing behind it,
	// which looks like a broken tunnel rather than a missing route.
	if !strings.Contains(body, "POSTROUTING -o eth0 -j MASQUERADE") {
		t.Errorf("no masquerade for the outbound interface:\n%s", body)
	}
}

func TestATunnelWithNoKeyIsRefused(t *testing.T) {
	if _, err := RenderServer(map[string]any{"name": "x", "address": "10.99.0.1/24"}, "eth0"); err == nil {
		t.Fatal("a tunnel with no private key was rendered anyway")
	}
}

func TestAPeerWithAHostileAllowedAddressIsDropped(t *testing.T) {
	body, err := RenderServer(map[string]any{
		"address":     "10.99.0.1/24",
		"private_key": "a2V5",
		"peers": []any{
			map[string]any{"public_key": "a2V5", "allowed_ips": []any{"10.99.0.2/32; rm -rf /"}},
			map[string]any{"public_key": "b2s=", "allowed_ips": []any{"10.99.0.3/32"}},
		},
	}, "eth0")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(body, "rm -rf") {
		t.Fatalf("a shell metacharacter reached the configuration:\n%s", body)
	}
	// The good peer still lands: one bad entry must not lose the tunnel.
	if strings.Count(body, "[Peer]") != 1 {
		t.Errorf("expected the valid peer to survive:\n%s", body)
	}
}

func TestAPrinterWithAHostileDeviceAddressNeverReachesLpadmin(t *testing.T) {
	env, runner := testEnv(t)

	for _, uri := range []string{"ipp://x; rm -rf /", "file:///etc/shadow", "$(id)", ""} {
		result := Run(context.Background(), Task{
			ID:      "1",
			Kind:    "printer-apply",
			Payload: map[string]any{"name": "ok", "device_uri": uri},
		}, env)
		if result.OK {
			t.Errorf("accepted %q", uri)
		}
	}
	if len(runner.commands) != 0 {
		t.Fatalf("lpadmin ran anyway: %v", runner.commands)
	}
}

func TestAPrinterWithoutAPpdIsConfiguredDriverless(t *testing.T) {
	env, runner := testEnv(t)

	result := Run(context.Background(), Task{
		ID:   "1",
		Kind: "printer-apply",
		Payload: map[string]any{
			"name":       "finance-mfp",
			"device_uri": "ipp://10.10.0.31/ipp/print",
			"duplex":     true,
			"shared":     true,
		},
	}, env)
	if !result.OK {
		t.Fatalf("apply failed: %s", result.Output)
	}

	var lpadmin []string
	for _, command := range runner.commands {
		if command[0] == "lpadmin" {
			lpadmin = command
		}
	}
	joined := strings.Join(lpadmin, " ")
	// "everywhere" is IPP Everywhere: CUPS works the printer out itself.
	if !strings.Contains(joined, "-m everywhere") {
		t.Errorf("not configured driverless: %s", joined)
	}
	if !strings.Contains(joined, "sides-default=two-sided-long-edge") {
		t.Errorf("duplex was not applied: %s", joined)
	}
}

func TestAnUploadedPpdIsWrittenAndNamedToLpadmin(t *testing.T) {
	env, runner := testEnv(t)

	result := Run(context.Background(), Task{
		ID:   "1",
		Kind: "printer-apply",
		Payload: map[string]any{
			"name":       "old-laser",
			"device_uri": "socket://10.10.0.40:9100",
			"ppd":        "*PPD-Adobe: \"4.3\"\n*ModelName: \"Old Laser\"\n",
		},
	}, env)
	if !result.OK {
		t.Fatalf("apply failed: %s", result.Output)
	}

	var joined string
	for _, command := range runner.commands {
		if command[0] == "lpadmin" {
			joined = strings.Join(command, " ")
		}
	}
	if strings.Contains(joined, "-m everywhere") {
		t.Errorf("a PPD was uploaded, so it should not be driverless: %s", joined)
	}
	if !strings.Contains(joined, "-P ") || !strings.Contains(joined, "old-laser.ppd") {
		t.Errorf("the PPD was not named to lpadmin: %s", joined)
	}
}
