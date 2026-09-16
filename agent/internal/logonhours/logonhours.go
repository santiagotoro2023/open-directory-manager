// Package logonhours decides whether somebody may sign in now.
//
// The rules come from the policy (apply/logonhours.go writes them); this is
// the reading side, run by PAM at every interactive sign-in and by a timer
// for the sessions that should end. It is a pure function of the rules, the
// person, their groups and the clock, so that what a machine will do on a
// Sunday at six can be tested on a Tuesday at noon.
package logonhours

import (
	"strings"
	"time"
)

// Rule mirrors policy.LogonHoursRule without importing the policy package,
// so the PAM helper stays small and the file it reads has one shape.
type Rule struct {
	Principal string   `json:"principal"`
	Days      []string `json:"days"`
	Start     string   `json:"start"`
	End       string   `json:"end"`
	SignOut   bool     `json:"sign_out"`
	Message   string   `json:"message"`
}

// File is the on-disk shape.
type File struct {
	Rules []Rule `json:"rules"`
}

// The services through which somebody signs in. Anything else asking the
// account stack — sudo, su, cron, systemd-user — is a person or a job
// already there, and is never refused by hours.
var signInServices = map[string]bool{
	"login": true, "gdm-password": true, "gdm-autologin": true, "gdm-launch-environment": false,
	"gdm": true, "sshd": true, "xrdp-sesman": true, "lightdm": true, "lightdm-greeter": false,
	"sddm": true, "cockpit": true,
}

// IsSignIn says whether a PAM service name is a sign-in.
func IsSignIn(service string) bool { return signInServices[service] }

var dayNames = map[time.Weekday]string{
	time.Monday: "mon", time.Tuesday: "tue", time.Wednesday: "wed", time.Thursday: "thu",
	time.Friday: "fri", time.Saturday: "sat", time.Sunday: "sun",
}

// Decision is what the rules say about one person right now.
type Decision struct {
	// Restricted is false when no rule names the person: they are not
	// subject to hours at all.
	Restricted bool
	Allowed    bool
	// The message of the rule that refused, for the person.
	Message string
	// Whether a rule naming the person asks for open sessions to end.
	SignOut bool
}

// Decide applies the rules to one person. user is the account name as PAM
// saw it (a domain account may carry @REALM, which is ignored); groups are
// the names the machine resolves for it.
func Decide(rules []Rule, user string, groups []string, now time.Time) Decision {
	name := strings.ToLower(user)
	if at := strings.IndexByte(name, '@'); at > 0 {
		name = name[:at]
	}
	member := map[string]bool{}
	for _, group := range groups {
		g := strings.ToLower(group)
		if at := strings.IndexByte(g, '@'); at > 0 {
			g = g[:at]
		}
		member[g] = true
	}
	decision := Decision{}
	message := ""
	for _, rule := range rules {
		principal := strings.ToLower(rule.Principal)
		switch {
		case strings.HasPrefix(principal, "%"):
			if !member[principal[1:]] {
				continue
			}
		case principal != name:
			continue
		}
		decision.Restricted = true
		if rule.SignOut {
			decision.SignOut = true
		}
		if message == "" && rule.Message != "" {
			message = rule.Message
		}
		if within(rule, now) {
			decision.Allowed = true
		}
	}
	if !decision.Restricted {
		decision.Allowed = true
		return decision
	}
	if !decision.Allowed {
		if message == "" {
			message = "Signing in is not allowed at this time of day."
		}
		decision.Message = message
	}
	return decision
}

// within says whether now falls in the rule's window. A window whose end is
// not after its start crosses midnight: 22:00–06:00 on Monday runs until
// Tuesday morning.
func within(rule Rule, now time.Time) bool {
	start, ok1 := minutes(rule.Start)
	end, ok2 := minutes(rule.End)
	if !ok1 || !ok2 {
		return false
	}
	current := now.Hour()*60 + now.Minute()
	today := dayNames[now.Weekday()]
	yesterday := dayNames[now.AddDate(0, 0, -1).Weekday()]
	if end > start {
		return hasDay(rule.Days, today) && current >= start && current < end
	}
	// Crossing midnight: this evening on a listed day, or this morning after
	// a listed day.
	if hasDay(rule.Days, today) && current >= start {
		return true
	}
	return hasDay(rule.Days, yesterday) && current < end
}

func hasDay(days []string, day string) bool {
	for _, entry := range days {
		if strings.EqualFold(entry, day) {
			return true
		}
	}
	return false
}

func minutes(clock string) (int, bool) {
	parts := strings.SplitN(clock, ":", 2)
	if len(parts) != 2 {
		return 0, false
	}
	hours, minutes := 0, 0
	for _, r := range parts[0] {
		if r < '0' || r > '9' {
			return 0, false
		}
		hours = hours*10 + int(r-'0')
	}
	for _, r := range parts[1] {
		if r < '0' || r > '9' {
			return 0, false
		}
		minutes = minutes*10 + int(r-'0')
	}
	if hours > 23 || minutes > 59 {
		return 0, false
	}
	return hours*60 + minutes, true
}
