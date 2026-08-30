// Package policy is the wire format of the effective-policy document the
// ODM API hands to an agent.
//
// The agent deliberately holds no precedence logic: inheritance, link order,
// enforcement, security filtering and item-level targeting are all resolved
// server-side, and this is just the flattened result (CLAUDE.md §5.2).
package policy

// Document is one machine's or one user's resolved policy.
type Document struct {
	Target         Target     `json:"target"`
	AppliedGPOs    []GPORef   `json:"applied_gpos"`
	SkippedGPOs    []SkipNote `json:"skipped_gpos"`
	Settings       Settings   `json:"settings"`
	Serial         string     `json:"serial"`
	RefreshMinutes int        `json:"refresh_minutes"`
}

type Target struct {
	DN       string `json:"dn"`
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
}

type GPORef struct {
	GUID string `json:"guid"`
	Name string `json:"name"`
}

type SkipNote struct {
	GUID   string `json:"guid"`
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

type Settings struct {
	Files                []File                 `json:"files,omitempty"`
	Scripts              []Script               `json:"scripts,omitempty"`
	SystemdUnits         []SystemdUnit          `json:"systemd_units,omitempty"`
	Cron                 []CronJob              `json:"cron,omitempty"`
	Firewall             []Firewall             `json:"firewall,omitempty"`
	DriveMaps            []DriveMap             `json:"drive_maps,omitempty"`
	SudoRules            []SudoRule             `json:"sudo_rules,omitempty"`
	HbacRules            []HbacRule             `json:"hbac_rules,omitempty"`
	TrustedCerts         []TrustedCert          `json:"trusted_certificates,omitempty"`
	Packages             []Package              `json:"packages,omitempty"`
	Browser              *Browser               `json:"browser,omitempty"`
	Wallpaper            *Wallpaper             `json:"wallpaper,omitempty"`
	Updates              *Updates               `json:"updates,omitempty"`
	LoginScreen          *LoginScreen           `json:"login_screen,omitempty"`
	CertificateEnrolment []CertificateEnrolment `json:"certificate_enrolment,omitempty"`
	Printers             []Printer              `json:"printers,omitempty"`
	AlwaysOnVpn          *AlwaysOnVpn           `json:"always_on_vpn,omitempty"`
	LocalAdministrator   *LocalAdministrator    `json:"local_administrator,omitempty"`
	Agent                *AgentConfig           `json:"agent,omitempty"`
}

// Updates configures unattended apt upgrades.
type Updates struct {
	Enabled      bool   `json:"enabled"`
	SecurityOnly bool   `json:"security_only"`
	Schedule     string `json:"schedule"`
	AutoReboot   bool   `json:"auto_reboot"`
	RebootTime   string `json:"reboot_time"`
	RemoveUnused bool   `json:"remove_unused"`
}

type File struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    string `json:"mode"`
	Owner   string `json:"owner"`
	Group   string `json:"group"`
}

type Script struct {
	Trigger     string `json:"trigger"`
	Name        string `json:"name"`
	Interpreter string `json:"interpreter"`
	Content     string `json:"content"`
}

type SystemdUnit struct {
	Unit  string `json:"unit"`
	State string `json:"state"`
}

type CronJob struct {
	Name     string `json:"name"`
	Schedule string `json:"schedule"`
	Command  string `json:"command"`
	User     string `json:"user"`
}

type Firewall struct {
	Name      string `json:"name"`
	Action    string `json:"action"`
	Direction string `json:"direction"`
	Protocol  string `json:"protocol"`
	Port      int    `json:"port"`
	Source    string `json:"source"`
}

type DriveMap struct {
	Name         string `json:"name"`
	UNC          string `json:"unc"`
	MountPoint   string `json:"mount_point"`
	ForPrincipal string `json:"for_principal"`
	Options      string `json:"options"`
}

type SudoRule struct {
	Name     string   `json:"name"`
	Users    []string `json:"users"`
	Commands []string `json:"commands"`
	RunAs    string   `json:"run_as"`
	NoPasswd bool     `json:"nopasswd"`
}

// HbacRule is host-based access control: who may open a session on this
// machine, and through which service.
type HbacRule struct {
	Principal string `json:"principal"`
	Service   string `json:"service"`
	Access    string `json:"access"`
}

// Package is an apt package the machine should have, or should not.
type Package struct {
	Name  string `json:"name"`
	State string `json:"state"` // present | latest | absent
}

// TrustedCert is a certificate to install into the system trust store.
type TrustedCert struct {
	Name           string `json:"name"`
	CertificatePEM string `json:"certificate_pem"`
}

type Browser struct {
	Chromium map[string]any `json:"chromium,omitempty"`
	Firefox  map[string]any `json:"firefox,omitempty"`
}

type Wallpaper struct {
	URI             string `json:"uri"`
	PictureOptions  string `json:"picture_options"`
	ForPrincipal    string `json:"for_principal"`
	AllowUserChange bool   `json:"allow_user_change"`
}

// LoginScreen is the greeter, before anyone has signed in.
type LoginScreen struct {
	BannerText          string `json:"banner_text"`
	BackgroundURI       string `json:"background_uri"`
	BackgroundFit       string `json:"background_fit"`
	AllowUserBackground bool   `json:"allow_user_background"`
	DisableUserList     bool   `json:"disable_user_list"`
}

// CertificateEnrolment is a certificate this machine should hold and keep.
type CertificateEnrolment struct {
	Profile         string `json:"profile"`
	Path            string `json:"path"`
	ValidityDays    int    `json:"validity_days"`
	RenewBeforeDays int    `json:"renew_before_days"`
}

// Printer is a printer handed to a user or group.
type Printer struct {
	Name         string `json:"name"`
	Server       string `json:"server"`
	ForPrincipal string `json:"for_principal"`
	Default      bool   `json:"default"`
}

// LocalAdministrator is a local account whose password this machine chooses
// and rotates itself — what Active Directory calls LAPS. The password is
// never in the policy: the machine generates it and reports it back, so it
// differs on every machine and one recovered from a stolen laptop opens
// nothing else.
type LocalAdministrator struct {
	Account       string `json:"account"`
	RotateDays    int    `json:"rotate_days"`
	Length        int    `json:"length"`
	Administrator bool   `json:"administrator"`
}

// AlwaysOnVpn holds a tunnel up whatever the person using the machine does.
//
// Configuration is filled in by the control plane for the machine asking, not
// by whoever wrote the policy: it carries a private key belonging to one
// machine, so it only ever travels to that one.
type AlwaysOnVpn struct {
	Tunnel              string            `json:"tunnel"`
	BlockUntilConnected bool              `json:"block_until_connected"`
	Configuration       *VpnConfiguration `json:"configuration,omitempty"`
	Unavailable         string            `json:"unavailable,omitempty"`
}

type VpnConfiguration struct {
	Name          string   `json:"name"`
	Address       string   `json:"address"`
	PrivateKey    string   `json:"private_key"`
	PeerPublicKey string   `json:"peer_public_key"`
	Endpoint      string   `json:"endpoint"`
	AllowedIPs    []string `json:"allowed_ips"`
	DNS           []string `json:"dns"`
	SearchDomain  string   `json:"search_domain"`
}

type AgentConfig struct {
	RefreshMinutes int `json:"refresh_minutes"`
}

// Result is one line of Resultant Set of Policy sent back to the API.
type Result struct {
	Setting string `json:"setting"`
	Status  string `json:"status"` // success | failed | skipped
	Reason  string `json:"reason,omitempty"`
}

// Report is what the agent posts after an apply run.
type Report struct {
	PolicySerial string   `json:"policy_serial"`
	AgentVersion string   `json:"agent_version"`
	AppliedGPOs  []GPORef `json:"applied_gpos"`
	Results      []Result `json:"results"`
	// Present only on the run that rotated it. The control plane stores it so
	// an administrator can read it off the computer object when the domain is
	// unreachable from that machine.
	LocalAdministrator *LocalAdministratorCredential `json:"local_administrator,omitempty"`
}

// LocalAdministratorCredential is what a machine reports after rotating.
type LocalAdministratorCredential struct {
	Account   string `json:"account"`
	Password  string `json:"password"`
	Rotated   string `json:"rotated"`
	ExpiresAt string `json:"expires_at"`
}

func Ok(setting string) Result  { return Result{Setting: setting, Status: "success"} }
func Skip(s, why string) Result { return Result{Setting: s, Status: "skipped", Reason: why} }
func Fail(s string, err error) Result {
	return Result{Setting: s, Status: "failed", Reason: err.Error()}
}
