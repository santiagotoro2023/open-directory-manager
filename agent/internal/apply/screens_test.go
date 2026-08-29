package apply

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"odm.example.org/agent/internal/policy"
)

type quietRunner struct{ commands [][]string }

func (r *quietRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	r.commands = append(r.commands, append([]string{name}, args...))
	return "", nil
}

func screenEnv(t *testing.T) (Env, *quietRunner) {
	t.Helper()
	runner := &quietRunner{}
	env := NewEnv(t.TempDir())
	env.Run = runner
	return env, runner
}

func readManaged(t *testing.T, env Env, path string) string {
	t.Helper()
	body, err := os.ReadFile(env.Path(path))
	if err != nil {
		t.Fatalf("%s was not written: %v", path, err)
	}
	return string(body)
}

func TestALoginBannerIsWrittenToTheGreetersOwnDatabase(t *testing.T) {
	env, _ := screenEnv(t)

	results := applyLoginScreen(context.Background(), policy.Settings{
		LoginScreen: &policy.LoginScreen{BannerText: "Welcome to Example Corp"},
	}, env)

	if len(results) == 0 {
		t.Fatal("nothing was applied")
	}
	// GDM reads its own dconf database; without the profile the keys are
	// written and never read.
	profile := readManaged(t, env, greeterProfilePath)
	if !strings.Contains(profile, "system-db:gdm") {
		t.Errorf("the greeter profile does not name the gdm database:\n%s", profile)
	}
	keyfile := readManaged(t, env, greeterKeyfilePath)
	if !strings.Contains(keyfile, "banner-message-enable=true") {
		t.Errorf("the banner was not enabled:\n%s", keyfile)
	}
	if !strings.Contains(keyfile, "banner-message-text='Welcome to Example Corp'") {
		t.Errorf("the banner text is wrong:\n%s", keyfile)
	}
}

func TestRemovingTheBannerTextDisablesItRatherThanLeavingItUp(t *testing.T) {
	env, _ := screenEnv(t)

	applyLoginScreen(context.Background(), policy.Settings{
		LoginScreen: &policy.LoginScreen{BannerText: ""},
	}, env)

	keyfile := readManaged(t, env, greeterKeyfilePath)
	if !strings.Contains(keyfile, "banner-message-enable=false") {
		t.Errorf("an empty banner has to be written as off:\n%s", keyfile)
	}
}

func TestALoginBackgroundBecomesGreeterStyling(t *testing.T) {
	env, _ := screenEnv(t)

	applyLoginScreen(context.Background(), policy.Settings{
		LoginScreen: &policy.LoginScreen{
			BackgroundURI: "file:///usr/share/backgrounds/corp.png",
			BackgroundFit: "zoom",
		},
	}, env)

	css := readManaged(t, env, greeterCssPath)
	if !strings.Contains(css, "/usr/share/backgrounds/corp.png") {
		t.Errorf("the image is missing:\n%s", css)
	}
	if !strings.Contains(css, "background-size: cover") {
		t.Errorf("zoom should become cover:\n%s", css)
	}
}

func TestABannerCannotBreakOutOfItsDconfValue(t *testing.T) {
	env, _ := screenEnv(t)

	applyLoginScreen(context.Background(), policy.Settings{
		LoginScreen: &policy.LoginScreen{BannerText: "a' \nkey=value"},
	}, env)

	keyfile := readManaged(t, env, greeterKeyfilePath)
	for _, line := range strings.Split(keyfile, "\n") {
		if line == "key=value" {
			t.Fatalf("a banner injected a key:\n%s", keyfile)
		}
	}
}

func TestTheDesktopBackgroundIsLockedUnlessTheUserMayChangeIt(t *testing.T) {
	env, _ := screenEnv(t)

	applyWallpaper(context.Background(), policy.Settings{
		Wallpaper: &policy.Wallpaper{URI: "file:///corp.png", AllowUserChange: false},
	}, env)
	if locks := readManaged(t, env, dconfLockPath); !strings.Contains(locks, "picture-uri") {
		t.Errorf("the background was not locked:\n%s", locks)
	}

	applyWallpaper(context.Background(), policy.Settings{
		Wallpaper: &policy.Wallpaper{URI: "file:///corp.png", AllowUserChange: true},
	}, env)
	if locks := readManaged(t, env, dconfLockPath); strings.TrimSpace(locks) != "" {
		t.Errorf("a user allowed to change it must not be locked out:\n%s", locks)
	}
}

func TestAlwaysOnVpnWritesARootOnlyTunnelAndEnablesIt(t *testing.T) {
	env, runner := screenEnv(t)

	results := applyAlwaysOnVpn(context.Background(), policy.Settings{
		AlwaysOnVpn: &policy.AlwaysOnVpn{
			Tunnel: "homeoffice",
			Configuration: &policy.VpnConfiguration{
				Address:       "10.99.0.3/32",
				PrivateKey:    "cGVlci1wcml2YXRl",
				PeerPublicKey: "c2VydmVyLXB1YmxpYw==",
				Endpoint:      "vpn.corp.example.internal:51820",
				AllowedIPs:    []string{"10.10.0.0/24"},
				DNS:           []string{"10.10.0.10"},
				SearchDomain:  "corp.example.internal",
			},
		},
	}, env)

	if len(results) != 1 || results[0].Status == "failed" {
		t.Fatalf("apply failed: %+v", results)
	}
	path := filepath.Join("/etc/wireguard", "homeoffice.conf")
	info, err := os.Stat(env.Path(path))
	if err != nil {
		t.Fatalf("%s was not written: %v", path, err)
	}
	// The file is the machine's identity on the tunnel; nobody else reads it.
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("expected 0600, got %o", mode)
	}

	body := readManaged(t, env, path)
	if !strings.Contains(body, "PersistentKeepalive = 25") {
		t.Errorf("no keepalive, so a home router will drop it:\n%s", body)
	}
	if !strings.Contains(body, "DNS = 10.10.0.10, corp.example.internal") {
		t.Errorf("the search domain is missing:\n%s", body)
	}

	var enabled bool
	for _, command := range runner.commands {
		if strings.Join(command, " ") == "systemctl enable wg-quick@homeoffice" {
			enabled = true
		}
	}
	if !enabled {
		t.Errorf("the tunnel was not enabled at boot: %v", runner.commands)
	}
}

func TestAMachineWithNoPeerIsSkippedWithAReason(t *testing.T) {
	env, runner := screenEnv(t)

	results := applyAlwaysOnVpn(context.Background(), policy.Settings{
		AlwaysOnVpn: &policy.AlwaysOnVpn{
			Tunnel:      "homeoffice",
			Unavailable: "this machine has no peer on that tunnel",
		},
	}, env)

	if len(results) != 1 || results[0].Status != "skipped" {
		t.Fatalf("expected one skipped result, got %+v", results)
	}
	if len(runner.commands) != 0 {
		t.Errorf("nothing should have run: %v", runner.commands)
	}
}

func TestBlockUntilConnectedBlackholesTheTunnelsRoutes(t *testing.T) {
	env, _ := screenEnv(t)

	body := RenderTunnel(policy.VpnConfiguration{
		Address:       "10.99.0.3/32",
		PrivateKey:    "a2V5",
		PeerPublicKey: "a2V5",
		Endpoint:      "vpn:51820",
		AllowedIPs:    []string{"10.10.0.0/24", "10.20.0.0/24"},
	}, true)
	_ = env

	if !strings.Contains(body, "blackhole 10.10.0.0/24") ||
		!strings.Contains(body, "blackhole 10.20.0.0/24") {
		t.Errorf("routes are not blocked before the tunnel is up:\n%s", body)
	}
	if !strings.Contains(body, "PreDown") {
		t.Errorf("the blackholes are never removed:\n%s", body)
	}
}
