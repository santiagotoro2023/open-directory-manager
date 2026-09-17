// Package policy is the wire format of the effective-policy document the
// ODM API hands to an agent.
//
// The agent deliberately holds no precedence logic: inheritance, link order,
// enforcement, security filtering and item-level targeting are all resolved
// server-side, and this is just the flattened result (CLAUDE.md §5.2).
package policy

import "encoding/json"

// Document is one machine's or one user's resolved policy.
type Document struct {
	Target         Target     `json:"target"`
	AppliedGPOs    []GPORef   `json:"applied_gpos"`
	SkippedGPOs    []SkipNote `json:"skipped_gpos"`
	Settings       Settings   `json:"settings"`
	Serial         string     `json:"serial"`
	RefreshMinutes int        `json:"refresh_minutes"`
	// What the console would hand out if this machine asked for it. Sent on
	// every poll, so an agent can report how far behind it is even where
	// policy says to change nothing.
	AgentAvailable *AgentAvailable `json:"agent_available,omitempty"`
	// What the account itself carries, as opposed to what a policy object
	// says about it. Only present on a document resolved for one person.
	User UserDetails `json:"user"`
	// Whether this machine measures itself, and what it probes. Not a
	// policy setting: it follows from the monitoring role existing anywhere
	// in the domain, and is carried here because this document is what the
	// agent already fetches on every poll. Decoded by the monitor package.
	Monitoring json.RawMessage `json:"monitoring,omitempty"`
}

// UserDetails is what the directory holds about the person signing in.
type UserDetails struct {
	// Their picture, base64. From the directory, so it is the same picture on
	// every machine rather than one per desktop they have used.
	Photo string `json:"photo"`
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
	CustomPackages       []CustomPackage        `json:"custom_packages,omitempty"`
	Browser              *Browser               `json:"browser,omitempty"`
	Wallpaper            *Wallpaper             `json:"wallpaper,omitempty"`
	RoamingProfile       *RoamingProfile        `json:"roaming_profile,omitempty"`
	Updates              *Updates               `json:"updates,omitempty"`
	LoginScreen          *LoginScreen           `json:"login_screen,omitempty"`
	CertificateEnrolment []CertificateEnrolment `json:"certificate_enrolment,omitempty"`
	WifiNetworks         []WifiNetwork          `json:"wifi_networks,omitempty"`
	Printers             []Printer              `json:"printers,omitempty"`
	RemoteDesktopFiles   []RemoteDesktopFile    `json:"remote_desktop_files,omitempty"`
	DefaultApplications  []DefaultApplication   `json:"default_applications,omitempty"`
	Dash                 []DashLayout           `json:"dash,omitempty"`
	Sysctl               []SysctlSetting        `json:"sysctl,omitempty"`
	Shortcuts            []Shortcut             `json:"shortcuts,omitempty"`
	Fonts                []Font                 `json:"fonts,omitempty"`
	Power                *PowerSettings         `json:"power,omitempty"`
	ScreenLock           *ScreenLock            `json:"screen_lock,omitempty"`
	RemovableStorage     *RemovableStorage      `json:"removable_storage,omitempty"`
	DeviceControl        *DeviceControl         `json:"device_control,omitempty"`
	PasswordManager      *PasswordManager       `json:"password_manager,omitempty"`
	DesktopTheme         *DesktopTheme          `json:"desktop_theme,omitempty"`
	SecondFactor         *SecondFactor          `json:"second_factor,omitempty"`
	FirstRun             *FirstRun              `json:"first_run,omitempty"`
	SoftwareControl      *SoftwareControl       `json:"software_control,omitempty"`
	AlwaysOnVpn          *AlwaysOnVpn           `json:"always_on_vpn,omitempty"`
	LocalAdministrator   *LocalAdministrator    `json:"local_administrator,omitempty"`
	GraphicsDrivers      *GraphicsDrivers       `json:"graphics_drivers,omitempty"`
	Grub                 *Grub                  `json:"grub,omitempty"`
	LocalPasswordPolicy  *LocalPasswordPolicy   `json:"local_password_policy,omitempty"`
	RemoteDesktopSession *RemoteDesktopSession  `json:"remote_desktop_session,omitempty"`
	AgentUpdate          *AgentUpdate           `json:"agent_update,omitempty"`
	Agent                *AgentConfig           `json:"agent,omitempty"`
	Regional             *Regional              `json:"regional,omitempty"`
	// Hostname is the name the console assigned under a Computer names
	// policy — present only while the machine still has to take it.
	Hostname        *Hostname        `json:"hostname,omitempty"`
	LogonHours      []LogonHoursRule `json:"logon_hours,omitempty"`
	FirmwareUpdates *FirmwareUpdates `json:"firmware_updates,omitempty"`
	WebApps         []WebApp         `json:"web_apps,omitempty"`
}

// Hostname is the name a machine should take.
type Hostname struct {
	Wanted string `json:"wanted"`
	FQDN   string `json:"fqdn"`
}

// PasswordManager is what is left of the password-manager setting once the
// control plane has turned its browser half into browser policy: whether the
// desktop app is wanted, and the vault it points at.
type PasswordManager struct {
	VaultURL   string `json:"vault_url"`
	DesktopApp bool   `json:"desktop_app"`
}

// DeviceControl is whether Bluetooth, cameras and microphones may be used.
type DeviceControl struct {
	Bluetooth  string   `json:"bluetooth"`
	Camera     string   `json:"camera"`
	Microphone string   `json:"microphone"`
	AllowedUSB []string `json:"allowed_usb"`
}

// Regional is the language, keyboard, time zone and formats of a machine.
type Regional struct {
	Locale            string   `json:"locale"`
	FormatsLocale     string   `json:"formats_locale"`
	AdditionalLocales []string `json:"additional_locales"`
	KeyboardLayout    string   `json:"keyboard_layout"`
	KeyboardVariant   string   `json:"keyboard_variant"`
	Timezone          string   `json:"timezone"`
	AllowUserChange   bool     `json:"allow_user_change"`
}

// LogonHoursRule is when one principal may sign in: Active Directory's
// logon hours, on the policy object.
type LogonHoursRule struct {
	Principal string   `json:"principal"`
	Days      []string `json:"days"`
	Start     string   `json:"start"`
	End       string   `json:"end"`
	SignOut   bool     `json:"sign_out"`
	Message   string   `json:"message"`
}

// FirmwareUpdates is fwupd by policy: report what could be updated, or
// install it.
type FirmwareUpdates struct {
	Enabled          bool   `json:"enabled"`
	Mode             string `json:"mode"`
	IncludeTesting   bool   `json:"include_testing"`
	RebootWhenNeeded bool   `json:"reboot_when_needed"`
}

// WebApp is a web site installed as if it were a program: a launcher that
// opens it in a browser window of its own.
type WebApp struct {
	Name       string   `json:"name"`
	URL        string   `json:"url"`
	IconURL    string   `json:"icon_url"`
	Browser    string   `json:"browser"`
	Categories []string `json:"categories"`
	Comment    string   `json:"comment"`
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
	DisplayName  string `json:"display_name"`
	ForPrincipal string `json:"for_principal"`
	Options      string `json:"options"`
}

// Label is what the file manager shows for this drive: the display name where
// one is set, and the drive's own name where it is not.
func (d DriveMap) Label() string {
	if d.DisplayName != "" {
		return d.DisplayName
	}
	return d.Name
}

// RemoteDesktopFile is a connection file to put on somebody's desktop.
type RemoteDesktopFile struct {
	Name         string `json:"name"`
	Address      string `json:"address"`
	Collection   string `json:"collection"`
	Application  string `json:"application"`
	FullScreen   bool   `json:"full_screen"`
	ForPrincipal string `json:"for_principal"`
}

// DefaultApplication is which program opens a kind of file.
//
// A machine setting: the association lives in the machine's own XDG
// configuration, and a file type that opens one program for one person and
// another for the next is a support call rather than a policy.
type DefaultApplication struct {
	// The MIME type, e.g. application/x-rdp.
	MimeType string `json:"mime_type"`
	// The desktop entry that opens it, e.g. org.remmina.Remmina.desktop.
	Application string `json:"application"`
	// File name extensions this type covers, comma separated and without the
	// dot. Only needed for a type the machine does not already know — .rdp
	// is not in shared-mime-info, so nothing could be the default for it.
	Extensions string `json:"extensions"`
}

// DashLayout is what is pinned to the desktop's dash, and in what order.
//
// A user setting, so one function group can have a different set from
// another, exactly as a drive map does.
type DashLayout struct {
	Name string `json:"name"`
	// Desktop entries in the order they should appear, comma separated.
	Applications string `json:"applications"`
	ForPrincipal string `json:"for_principal"`
	// Whether somebody signed in may then rearrange their own dash. Off by
	// default: applied at every sign-in like any other enforced setting.
	AllowUserChange bool `json:"allow_user_change"`
}

// PowerSettings is when the machine turns its screen off and suspends.
type PowerSettings struct {
	ScreenOffACMinutes      int    `json:"screen_off_ac_minutes"`
	ScreenOffBatteryMinutes int    `json:"screen_off_battery_minutes"`
	SuspendACMinutes        int    `json:"suspend_ac_minutes"`
	SuspendBatteryMinutes   int    `json:"suspend_battery_minutes"`
	LidCloseAction          string `json:"lid_close_action"`
	PowerButtonAction       string `json:"power_button_action"`
	AllowUserChange         bool   `json:"allow_user_change"`
}

// ScreenLock is when the screen locks itself.
type ScreenLock struct {
	IdleMinutes       int  `json:"idle_minutes"`
	LockDelaySeconds  int  `json:"lock_delay_seconds"`
	LockEnabled       bool `json:"lock_enabled"`
	LockOnSuspend     bool `json:"lock_on_suspend"`
	ShowNotifications bool `json:"show_notifications"`
	AllowUserChange   bool `json:"allow_user_change"`
}

// RemovableStorage is what may be done with a disk somebody plugs in.
type RemovableStorage struct {
	Mode             string   `json:"mode"` // allow | read_only | block
	ExemptPrincipals []string `json:"exempt_principals"`
	Message          string   `json:"message"`
}

// SysctlSetting is one kernel parameter.
type SysctlSetting struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// Shortcut is an icon on a desktop, an entry in a menu, or a place in a file
// manager.
type Shortcut struct {
	Name         string `json:"name"`
	Kind         string `json:"kind"` // application | link | place
	Target       string `json:"target"`
	Icon         string `json:"icon"`
	Where        string `json:"where"` // desktop | menu | both
	ForPrincipal string `json:"for_principal"`
}

// Font is a font file installed for everybody on the machine.
type Font struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

// DesktopTheme is how the desktop looks.
type DesktopTheme struct {
	GtkTheme        string `json:"gtk_theme"`
	IconTheme       string `json:"icon_theme"`
	CursorTheme     string `json:"cursor_theme"`
	InterfaceFont   string `json:"interface_font"`
	DocumentFont    string `json:"document_font"`
	MonospaceFont   string `json:"monospace_font"`
	ColourScheme    string `json:"colour_scheme"`
	AllowUserChange bool   `json:"allow_user_change"`
}

// SecondFactor is a code asked for at the machine as well as at the console.
// FirstRun is what somebody is shown the first time they sign in.
type FirstRun struct {
	DisableTour          bool   `json:"disable_tour"`
	DisableWelcomeDialog bool   `json:"disable_welcome_dialog"`
	Message              string `json:"message"`
}

type SecondFactor struct {
	Enabled bool `json:"enabled"`
	// "code" (the default) or "push": approved on a phone, with the code
	// asked for instead when the phone does not answer.
	Method string `json:"method"`
	// Where phones reach the notification server when that is not the
	// controller's own name (a port forwarded through a router). Empty uses
	// the controller's.
	PushServerURL     string   `json:"push_server_url"`
	SelfEnrol         bool     `json:"self_enrol"`
	Services          []string `json:"services"`
	RequirePrincipals []string `json:"require_principals"`
	ExemptPrincipals  []string `json:"exempt_principals"`
	GraceDays         int      `json:"grace_days"`
}

// SoftwareControl is which packages may be installed.
type SoftwareControl struct {
	Enabled      bool     `json:"enabled"`
	Allowed      []string `json:"allowed"`
	BlockFlatpak bool     `json:"block_flatpak"`
	BlockSnap    bool     `json:"block_snap"`
	Message      string   `json:"message"`
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

// CustomPackage is a .deb an operator uploaded directly, for software with
// no apt repository this machine can reach. The content is not here: it is
// fetched separately, from the control plane's own store, by PackageID.
//
// PackageName, Version and SHA256 are filled in by the control plane, not
// chosen by whoever wrote the policy object: they are what dpkg-deb actually
// found in the upload, which lets the agent skip the download entirely when
// that version is already installed.
type CustomPackage struct {
	Name      string `json:"name"`
	PackageID string `json:"package_id"`
	State     string `json:"state"` // present | absent
	// Left installed when the policy stops naming it, rather than removed.
	KeepWhenUnlinked bool   `json:"keep_when_unlinked"`
	PackageName      string `json:"package_name"`
	Version          string `json:"version"`
	SHA256           string `json:"sha256"`
	// Set instead of the three fields above when the upload this entry
	// named no longer exists.
	Unavailable string `json:"unavailable"`
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

// RoamingProfile puts a person's home directory on a share rather than on the
// machine they signed in to.
type RoamingProfile struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	DiskGB int    `json:"disk_gb"`
}

type Wallpaper struct {
	URI             string `json:"uri"`
	Image           string `json:"image"`
	ImageName       string `json:"image_name"`
	PictureOptions  string `json:"picture_options"`
	ForPrincipal    string `json:"for_principal"`
	AllowUserChange bool   `json:"allow_user_change"`
}

// LoginScreen is the greeter, before anyone has signed in.
type LoginScreen struct {
	BannerText          string `json:"banner_text"`
	BackgroundURI       string `json:"background_uri"`
	BackgroundImage     string `json:"background_image"`
	BackgroundImageName string `json:"background_image_name"`
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

// RemoteDesktopSession is what a session may carry between the client and the
// host it is running on. A rule about machines, so it comes from a policy
// object rather than from the collection.
type RemoteDesktopSession struct {
	AllowClipboard  bool `json:"allow_clipboard"`
	AllowPrinters   bool `json:"allow_printers"`
	AllowDrives     bool `json:"allow_drives"`
	AllowAudio      bool `json:"allow_audio"`
	AllowMicrophone bool `json:"allow_microphone"`
	MaxColourDepth  int  `json:"max_colour_depth"`
}

// LocalPasswordPolicy is what a password on this machine has to be, and how
// long it lasts. Domain accounts are not covered: those rules live on the
// domain object and the directory enforces them.
type LocalPasswordPolicy struct {
	MinimumLength    int      `json:"minimum_length"`
	RequireUppercase bool     `json:"require_uppercase"`
	RequireLowercase bool     `json:"require_lowercase"`
	RequireDigit     bool     `json:"require_digit"`
	RequireSymbol    bool     `json:"require_symbol"`
	MaximumAgeDays   int      `json:"maximum_age_days"`
	MinimumAgeDays   int      `json:"minimum_age_days"`
	WarnDays         int      `json:"warn_days"`
	Accounts         []string `json:"accounts,omitempty"`
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

// GraphicsDrivers is which GPU driver this machine should have.
//
// Never taken away once installed, unlike almost everything else a policy
// object controls: a driver a machine no longer needs is a driver it is safe
// to leave, and uninstalling one automatically is a machine that can lose
// its display the moment an operator unlinks the wrong GPO.
type GraphicsDrivers struct {
	Mode string `json:"mode"` // auto | nvidia | amd | none
}

// Grub is how long the boot loader waits, and whether it shows its menu at
// all, before starting the default entry — and, past the boot loader, the
// graphical splash Plymouth shows in place of the kernel and initramfs text
// a boot otherwise flashes on its way to the login screen.
type Grub struct {
	TimeoutSeconds int  `json:"timeout_seconds"`
	HideMenu       bool `json:"hide_menu"`

	BootSplash           bool   `json:"boot_splash"`
	Silent               bool   `json:"silent"`
	SplashMessage        string `json:"splash_message"`
	SplashImage          string `json:"splash_image"` // base64
	SplashImageName      string `json:"splash_image_name"`
	SplashBackground     string `json:"splash_background"` // base64
	SplashBackgroundName string `json:"splash_background_name"`
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

// AgentAvailable is the agent the console hands out.
type AgentAvailable struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
	Size    int64  `json:"size"`
}

// AgentUpdate is whether this machine takes it.
type AgentUpdate struct {
	// off, notify, install. Empty is off: a policy object written before this
	// existed must not start replacing binaries.
	Mode string `json:"mode"`
	// Empty follows whatever the console hands out; a version pins it.
	Version string `json:"version"`
}

// Report is what the agent posts after an apply run.
type Report struct {
	PolicySerial string `json:"policy_serial"`
	AgentVersion string `json:"agent_version"`
	// Set when the run was one person's session rather than the machine's own
	// pass: their drive maps and connection files are applied at sign-in, and
	// what happened to them belongs on their page in the console.
	Username    string   `json:"username,omitempty"`
	AppliedGPOs []GPORef `json:"applied_gpos"`
	Results     []Result `json:"results"`
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
	return Result{Setting: s, Status: "failed", Reason: shortened(err.Error())}
}

// The control plane accepts 512 characters of reason, and a command that
// prints more than that on failure — sysctl reporting every key on the
// machine, apt listing every dependency — took the whole report down with it:
// one over-long reason and the console showed no Resultant Set of Policy at
// all for that run, for any setting.
const reasonLimit = 512

// And 256 for the setting name, which is normally short but is sometimes
// built from a name an operator typed — a drive map, a printer — that this
// has to survive rather than trust.
const settingLimit = 256

func shortened(reason string) string {
	if len(reason) <= reasonLimit {
		return reason
	}
	// The end is where a command says what went wrong, so keep both ends.
	head, tail := reasonLimit*2/3, reasonLimit/3-len(reasonEllipsis)
	return reason[:head] + reasonEllipsis + reason[len(reason)-tail:]
}

func shortenedSetting(setting string) string {
	if len(setting) <= settingLimit {
		return setting
	}
	return setting[:settingLimit-len(reasonEllipsis)] + reasonEllipsis
}

// SanitizeForReport guarantees every result fits what the control plane
// accepts, whichever applier produced it.
//
// Fail already ran its reason through shortened, but that only covers a
// Result built through Fail — several appliers build one directly, with raw
// command output as the reason (a failed apt install's own dependency
// trace, in one case), and the API validates a report as a single unit: one
// reason over the limit refused the whole report, not just its own setting,
// so a machine that had in fact applied everything correctly reported
// nothing at all. Run once here, at the one place every report leaves the
// machine through, rather than trusted to every call site that builds a
// Result.
func SanitizeForReport(results []Result) []Result {
	sanitized := make([]Result, len(results))
	for i, result := range results {
		result.Setting = shortenedSetting(result.Setting)
		result.Reason = shortened(result.Reason)
		sanitized[i] = result
	}
	return sanitized
}

const reasonEllipsis = " […] "

// WifiNetwork is a wireless network the machine joins on its own — a
// NetworkManager system connection, there before anyone signs in. With
// wpa-eap it is 802.1X with the machine's own certificate: the machine joins
// because it is a domain member, and there is no password to write down.
type WifiNetwork struct {
	SSID            string `json:"ssid"`
	Hidden          bool   `json:"hidden"`
	Security        string `json:"security"`
	EAP             string `json:"eap"`
	CertificatePath string `json:"certificate_path"`
	ServerName      string `json:"server_name"`
	PSK             string `json:"psk"`
	Autoconnect     bool   `json:"autoconnect"`
	Priority        int    `json:"priority"`
}
