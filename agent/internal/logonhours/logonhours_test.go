package logonhours

import (
	"testing"
	"time"
)

func at(day time.Weekday, clock string) time.Time {
	// 2026-09-14 is a Monday.
	base := time.Date(2026, 9, 14, 0, 0, 0, 0, time.Local)
	base = base.AddDate(0, 0, int(day-time.Monday))
	m, _ := minutes(clock)
	return base.Add(time.Duration(m) * time.Minute)
}

func TestSomebodyNoRuleNamesIsNeverRestricted(t *testing.T) {
	rules := []Rule{{Principal: "%sales", Days: []string{"mon"}, Start: "09:00", End: "17:00"}}
	d := Decide(rules, "alice", []string{"engineering"}, at(time.Sunday, "03:00"))
	if d.Restricted || !d.Allowed {
		t.Fatalf("unrestricted person was refused: %+v", d)
	}
}

func TestOfficeHoursForAGroup(t *testing.T) {
	rules := []Rule{{Principal: "%Sales", Days: []string{"mon", "tue", "wed", "thu", "fri"},
		Start: "07:00", End: "19:00", Message: "Sales signs in during office hours."}}
	if d := Decide(rules, "bob@CORP", []string{"domain users@corp", "sales@corp"}, at(time.Tuesday, "09:30")); !d.Allowed {
		t.Fatalf("office hours refused: %+v", d)
	}
	d := Decide(rules, "bob", []string{"sales"}, at(time.Tuesday, "19:00"))
	if d.Allowed || d.Message != "Sales signs in during office hours." {
		t.Fatalf("after hours was allowed: %+v", d)
	}
	if d := Decide(rules, "bob", []string{"sales"}, at(time.Saturday, "10:00")); d.Allowed {
		t.Fatalf("a weekend was allowed: %+v", d)
	}
}

func TestSeveralRulesAddUpAndOneCrossesMidnight(t *testing.T) {
	rules := []Rule{
		{Principal: "%sales", Days: []string{"mon", "tue", "wed", "thu", "fri"}, Start: "07:00", End: "19:00"},
		{Principal: "carol", Days: []string{"fri"}, Start: "22:00", End: "06:00", SignOut: true},
	}
	groups := []string{"sales"}
	if d := Decide(rules, "carol", groups, at(time.Friday, "23:30")); !d.Allowed || !d.SignOut {
		t.Fatalf("the night shift was refused: %+v", d)
	}
	if d := Decide(rules, "carol", groups, at(time.Saturday, "05:59")); !d.Allowed {
		t.Fatalf("the morning after was refused: %+v", d)
	}
	if d := Decide(rules, "carol", groups, at(time.Saturday, "06:00")); d.Allowed {
		t.Fatalf("after the shift was allowed: %+v", d)
	}
	if d := Decide(rules, "carol", groups, at(time.Monday, "10:00")); !d.Allowed {
		t.Fatalf("the group's hours did not add up: %+v", d)
	}
}

func TestOnlySignInsAreGated(t *testing.T) {
	for _, service := range []string{"sudo", "su", "cron", "systemd-user", "polkit-1"} {
		if IsSignIn(service) {
			t.Errorf("%s is not a sign-in", service)
		}
	}
	for _, service := range []string{"sshd", "gdm-password", "login", "xrdp-sesman"} {
		if !IsSignIn(service) {
			t.Errorf("%s is a sign-in", service)
		}
	}
}
