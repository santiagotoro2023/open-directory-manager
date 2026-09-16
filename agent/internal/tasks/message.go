package tasks

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"odm.example.org/agent/internal/apply"
)

// A message for whoever is at the machine.
//
// What `msg` and `net send` did on Windows: a line from IT on every screen
// — "the file server restarts in ten minutes" — without an e-mail nobody
// reads in time. Every graphical session gets a desktop notification, shown
// as that person in their own session so it lands on their screen and not
// in a log; every terminal gets it through wall. Nothing is stored on the
// machine, and the audit log on the console is the record of it.

func sendMessage(ctx context.Context, payload map[string]any, env apply.Env) (string, error) {
	if env.Run == nil {
		return "", fmt.Errorf("no command runner")
	}
	title, _ := payload["title"].(string)
	text, _ := payload["text"].(string)
	urgency, _ := payload["urgency"].(string)
	if strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("the message is empty")
	}
	if title == "" {
		title = "Message from IT"
	}
	if urgency != "critical" {
		urgency = "normal"
	}
	sessions := graphicalSessions(ctx, env)
	shown := 0
	var problems []string
	for _, session := range sessions {
		// A critical notification stays until dismissed; a normal one goes
		// after a while. Either way it is the desktop's own, with the
		// console's name on it.
		args := []string{"--app-name=Open Directory Manager", "--icon=dialog-information",
			"--urgency=" + urgency}
		if urgency != "critical" {
			args = append(args, "--expire-time=60000")
		}
		args = append(args, "--", title, text)
		if _, err := runAs(ctx, env, session, "notify-send", args...); err != nil {
			problems = append(problems, session.user+": "+shortReason(err))
			continue
		}
		shown++
	}
	// And every terminal, which is where somebody over SSH is.
	_, _ = env.Run.Run(ctx, "wall", "-n", "--", title+"\n"+text)

	summary := fmt.Sprintf("shown to %d graphical session(s)", shown)
	if len(sessions) == 0 {
		summary = "nobody is signed in at a screen; written to the terminals"
	}
	if len(problems) > 0 {
		summary += "; not shown to " + strings.Join(problems, ", ")
	}
	return summary, nil
}

// graphicalSessions is every desktop somebody has open on this machine.
func graphicalSessions(ctx context.Context, env apply.Env) []assistSession {
	out, err := env.Run.Run(ctx, "loginctl", "list-sessions", "--no-legend")
	if err != nil {
		return nil
	}
	var sessions []assistSession
	seen := map[int]bool{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		uid, _ := strconv.Atoi(fields[1])
		if uid == 0 || seen[uid] {
			continue
		}
		detail, err := env.Run.Run(ctx, "loginctl", "show-session", fields[0], "-p", "Type", "-p", "Display")
		if err != nil {
			continue
		}
		values := map[string]string{}
		for _, entry := range strings.Split(detail, "\n") {
			if key, value, ok := strings.Cut(strings.TrimSpace(entry), "="); ok {
				values[key] = value
			}
		}
		if values["Type"] != "wayland" && values["Type"] != "x11" {
			continue
		}
		session := assistSession{user: fields[2], uid: uid, kind: values["Type"], display: values["Display"]}
		session.environment = desktopEnvironment(env, uid)
		if display := session.environment["DISPLAY"]; display != "" {
			session.display = display
		}
		seen[uid] = true
		sessions = append(sessions, session)
	}
	return sessions
}

func shortReason(err error) string {
	text := err.Error()
	if len(text) > 120 {
		text = text[:120] + "…"
	}
	return text
}
