// Package join is the single implementation of the domain-join sequence.
//
// Both front ends — the odm-client-install command and the desktop
// application — call this package, so a machine joined either way ends up
// with identical configuration (CLAUDE.md §5.6).
package join

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
)

// Options is everything a join needs. Anything left empty is either
// discovered or reported as missing by Validate.
type Options struct {
	Domain    string // corp.example.internal
	Realm     string // CORP.EXAMPLE.INTERNAL, derived from Domain when empty
	Server    string // a specific controller; discovered when empty
	APIURL    string // the control plane; derived from the domain when empty
	Hostname  string // this machine's fully-qualified name
	OU        string // container for the host account
	AdminUser string // join with this domain credential
	Password  string // that credential's password
	OTP       string // or enrol with a one-time token instead
	CACert    string // certificate validating the control plane's TLS
	NoAgent   bool   // join without installing the policy agent
	KeepName  bool   // leave this machine's name alone
	DryRun    bool   // report what would happen, change nothing
	Root      string // write beneath this directory instead of /
}

// Progress receives one line per step. Both front ends render it.
type Progress func(step string, detail string)

// Result is what the join produced.
type Result struct {
	Realm      string
	Domain     string
	Hostname   string
	Controller string
	Method     string // "credential" or "token"
	AgentSetUp bool
	Renamed    bool // this machine's own name was changed to join
}

var ErrMissing = errors.New("missing required option")

// Validate fills in what can be derived and reports what cannot.
func (o *Options) Validate() error {
	o.Domain = strings.TrimSpace(strings.ToLower(strings.TrimSuffix(o.Domain, ".")))
	if o.Domain == "" {
		return fmt.Errorf("%w: domain", ErrMissing)
	}
	if !validHostname(o.Domain) {
		return fmt.Errorf("invalid domain %q", o.Domain)
	}
	if o.Realm == "" {
		o.Realm = strings.ToUpper(o.Domain)
	}
	if o.Hostname == "" {
		host, err := os.Hostname()
		if err != nil {
			return fmt.Errorf("cannot determine the host name: %w", err)
		}
		o.Hostname = host
	}
	o.Hostname = strings.TrimSpace(strings.ToLower(o.Hostname))
	if !strings.Contains(o.Hostname, ".") {
		o.Hostname = o.Hostname + "." + o.Domain
	}
	if !validHostname(o.Hostname) {
		return fmt.Errorf("invalid host name %q", o.Hostname)
	}
	if o.Server != "" && !validHostname(o.Server) {
		return fmt.Errorf("invalid server %q", o.Server)
	}
	// The console's address is settled after the resolver is, because until
	// then nothing in the domain resolves. See consoleURL.
	if o.APIURL != "" && !strings.HasPrefix(o.APIURL, "https://") {
		return fmt.Errorf("the control plane URL must be https")
	}
	if o.OTP == "" && o.AdminUser == "" {
		return fmt.Errorf("%w: either an administrator credential or an enrolment token", ErrMissing)
	}
	return nil
}

// Run performs the join. Every step is reported through progress.
func Run(ctx context.Context, options Options, env Env, progress Progress) (*Result, error) {
	if progress == nil {
		progress = func(string, string) {}
	}
	if err := options.Validate(); err != nil {
		return nil, err
	}

	progress("Checking prerequisites", options.Hostname)
	if err := Preflight(ctx, options, env); err != nil {
		return nil, err
	}

	// The machine's own name has to be right before it joins: the account,
	// the keytab principal and the certificate subject all use it.
	name, err := PlanHostname(options)
	if err != nil {
		return nil, err
	}
	renamed := false
	if name.NeedsRename() {
		if options.KeepName {
			return nil, fmt.Errorf(
				"this machine is called %q, but joining %s needs %q; "+
					"drop --keep-hostname or set it yourself first",
				name.Current, options.Domain, name.Wanted,
			)
		}
		progress("Naming this machine", name.Wanted)
		if !options.DryRun {
			if err := ApplyHostname(ctx, name, env); err != nil {
				return nil, err
			}
		}
		renamed = true
	}
	options.Hostname = name.Wanted

	controller := options.Server
	if controller == "" {
		progress("Discovering the domain", options.Domain)
		found, err := DiscoverControllers(ctx, options.Domain)
		if err != nil {
			return nil, err
		}
		controller = found[0].Host
		progress("Found a domain controller", controller)
	}

	progress("Writing Kerberos configuration", Krb5ConfPath)
	if err := WriteKrb5Conf(options, env); err != nil {
		return nil, err
	}

	// Before anything asks the network where the domain is.
	if err := EnsureDomainResolves(ctx, options, controller, env); err != nil {
		return nil, err
	}
	if options.APIURL == "" {
		options.APIURL = consoleURL(options, controller)
		progress("Console", options.APIURL)
	}

	// Before the join, not after: net ads join reads this file first and
	// refuses on Debian's stock "standalone server".
	workgroup := Workgroup(ctx, options, controller, env)
	progress("Writing Samba configuration", SmbConfPath+" ("+workgroup+")")
	if err := WriteSmbConf(options, workgroup, env); err != nil {
		return nil, err
	}

	result := &Result{
		Realm:      options.Realm,
		Domain:     options.Domain,
		Hostname:   options.Hostname,
		Controller: controller,
		Renamed:    renamed,
	}

	if options.OTP != "" {
		progress("Enrolling with the control plane", options.APIURL)
		enrolment, err := Redeem(ctx, options)
		if err != nil {
			return nil, err
		}
		if err := WriteKeytab(env, enrolment.Keytab); err != nil {
			return nil, err
		}
		result.Method = "token"
		if enrolment.APIURL != "" {
			options.APIURL = enrolment.APIURL
		}
	} else {
		progress("Joining the domain", controller)
		if err := NetAdsJoin(ctx, options, env); err != nil {
			return nil, err
		}
		result.Method = "credential"
	}

	progress("Configuring identity and authentication", SssdConfPath)
	if err := WriteSssdConf(options, env); err != nil {
		return nil, err
	}
	if err := ConfigureNameService(ctx, options, env); err != nil {
		return nil, err
	}

	// Writing sssd.conf changes nothing until sssd reads it, so a join that
	// stopped here would look successful while no domain user could log in.
	progress("Starting identity services", "sssd")
	if err := StartServices(ctx, options, env); err != nil {
		return nil, err
	}

	if !options.NoAgent {
		progress("Installing the policy agent", AgentConfigPath)
		if err := InstallAgent(ctx, options, env); err != nil {
			return nil, err
		}
		result.AgentSetUp = true
	}

	progress("Done", result.Hostname)
	return result, nil
}

// consoleURL is where the agent will report. Settled after the resolver is
// pointed at the domain, because until then nothing in the domain resolves —
// and an address chosen before that fell back to the controller's IP, which
// the console's certificate does not cover:
//
//	certificate is valid for lern-st-odm-01..., not 192.168.1.171
//
// odm.<domain> is the name setup publishes and the certificate carries.
func consoleURL(options Options, controller string) string {
	convention := "odm." + options.Domain
	if _, err := net.LookupHost(convention); err == nil {
		return "https://" + convention + ":8443"
	}
	// No such record. The machine this one joined through is the next best
	// guess — by name where one is known, because a certificate names hosts
	// and not addresses.
	if controller != "" && net.ParseIP(controller) == nil {
		return "https://" + controller + ":8443"
	}
	if names, err := net.LookupAddr(controller); err == nil && len(names) > 0 {
		return "https://" + strings.TrimSuffix(names[0], ".") + ":8443"
	}
	return "https://" + convention + ":8443"
}
