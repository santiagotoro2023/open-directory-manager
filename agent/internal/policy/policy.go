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
	Files        []File        `json:"files,omitempty"`
	Scripts      []Script      `json:"scripts,omitempty"`
	SystemdUnits []SystemdUnit `json:"systemd_units,omitempty"`
	Cron         []CronJob     `json:"cron,omitempty"`
	Firewall     []Firewall    `json:"firewall,omitempty"`
	DriveMaps    []DriveMap    `json:"drive_maps,omitempty"`
	SudoRules    []SudoRule    `json:"sudo_rules,omitempty"`
	HbacRules    []HbacRule    `json:"hbac_rules,omitempty"`
	TrustedCerts []TrustedCert `json:"trusted_certificates,omitempty"`
	Packages     []Package     `json:"packages,omitempty"`
	Browser      *Browser      `json:"browser,omitempty"`
	Wallpaper    *Wallpaper    `json:"wallpaper,omitempty"`
	Agent        *AgentConfig  `json:"agent,omitempty"`
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
	URI            string `json:"uri"`
	PictureOptions string `json:"picture_options"`
	ForPrincipal   string `json:"for_principal"`
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
}

func Ok(setting string) Result  { return Result{Setting: setting, Status: "success"} }
func Skip(s, why string) Result { return Result{Setting: s, Status: "skipped", Reason: why} }
func Fail(s string, err error) Result {
	return Result{Setting: s, Status: "failed", Reason: err.Error()}
}
