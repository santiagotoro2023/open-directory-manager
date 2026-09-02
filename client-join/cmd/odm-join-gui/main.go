//go:build gui

// Command odm-join-gui joins this machine to an ODM domain from the desktop.
//
// It is a view over the same join library the odm-client-install command
// uses, so a machine joined either way ends up with identical configuration
// (CLAUDE.md §5.6).
package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/widget"

	"odm.example.org/client-join/join"
)

const version = "0.7.4"

// Branding is installed by the package; the repository keeps one copy of
// each asset and the application reads it from disk.
var brandingPaths = []string{
	"/usr/share/odm/branding",
	"/usr/local/share/odm/branding",
	"branding",
	"../branding",
	"../../branding",
}

func brandingFile(name string) string {
	for _, directory := range brandingPaths {
		path := directory + "/" + name
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return ""
}

func main() {
	application := app.NewWithID("org.example.odm.join")
	if icon := brandingFile("odm-mark.svg"); icon != "" {
		if body, err := os.ReadFile(icon); err == nil {
			application.SetIcon(fyne.NewStaticResource("odm-mark.svg", body))
		}
	}

	window := application.NewWindow("Join Domain — Open Directory Manager")
	window.Resize(fyne.NewSize(640, 620))
	window.SetContent(buildForm(window))
	window.ShowAndRun()
}

func buildForm(window fyne.Window) fyne.CanvasObject {
	domain := widget.NewEntry()
	domain.SetPlaceHolder("corp.example.internal")

	server := widget.NewEntry()
	server.SetPlaceHolder("discovered automatically")

	admin := widget.NewEntry()
	admin.SetPlaceHolder("Administrator")

	password := widget.NewPasswordEntry()

	token := widget.NewEntry()
	token.SetPlaceHolder("enrolment token")

	organizationalUnit := widget.NewEntry()
	organizationalUnit.SetPlaceHolder("optional, e.g. OU=Workstations,DC=corp,DC=example,DC=internal")

	credentialForm := widget.NewForm(
		widget.NewFormItem("Administrator account", admin),
		widget.NewFormItem("Password", password),
	)
	tokenForm := widget.NewForm(widget.NewFormItem("Enrolment token", token))
	tokenForm.Hide()

	method := widget.NewRadioGroup(
		[]string{"Administrator credential", "Enrolment token"},
		func(choice string) {
			if choice == "Enrolment token" {
				credentialForm.Hide()
				tokenForm.Show()
				return
			}
			tokenForm.Hide()
			credentialForm.Show()
		},
	)
	method.SetSelected("Administrator credential")
	method.Horizontal = true

	status := widget.NewLabel("")
	status.Wrapping = fyne.TextWrapWord
	progress := widget.NewProgressBarInfinite()
	progress.Hide()

	log := widget.NewLabel("")
	log.Wrapping = fyne.TextWrapWord
	logScroll := container.NewVScroll(log)
	logScroll.SetMinSize(fyne.NewSize(0, 180))

	joinButton := widget.NewButton("Join domain", nil)
	joinButton.Importance = widget.HighImportance

	joinButton.OnTapped = func() {
		options := join.Options{
			Domain:   strings.TrimSpace(domain.Text),
			Server:   strings.TrimSpace(server.Text),
			OU:       strings.TrimSpace(organizationalUnit.Text),
			CACert:   "",
			Hostname: "",
		}
		if method.Selected == "Enrolment token" {
			options.OTP = strings.TrimSpace(token.Text)
		} else {
			options.AdminUser = strings.TrimSpace(admin.Text)
			options.Password = password.Text
		}

		if err := options.Validate(); err != nil {
			setStatus(status, "Cannot start: "+err.Error())
			return
		}

		joinButton.Disable()
		progress.Show()
		setStatus(status, "Joining "+options.Domain+"…")
		setText(log, "")

		go func() {
			var lines []string
			result, err := join.Run(
				context.Background(),
				options,
				join.NewEnv(""),
				func(step, detail string) {
					line := step
					if detail != "" {
						line += ": " + detail
					}
					lines = append(lines, line)
					setText(log, strings.Join(lines, "\n"))
				},
			)

			runOnMain(func() {
				progress.Hide()
				joinButton.Enable()
			})
			if err != nil {
				setStatus(status, "Join failed: "+err.Error())
				return
			}
			message := fmt.Sprintf(
				"Joined %s as %s. Controller %s. Agent %s.",
				result.Domain, result.Hostname, result.Controller,
				map[bool]string{true: "installed", false: "not installed"}[result.AgentSetUp],
			)
			if result.Renamed {
				message += "\nThis machine was renamed. Reboot to finish."
			}
			if result.UntrustedConsole {
				// Joined, but the agent will fail every request until it
				// holds the console's certificate.
				message += "\nThe agent cannot verify the console's certificate and will not " +
					"report. Copy /etc/odm/tls/api.crt from the console and run: " +
					"sudo odm-agent trust <file>"
			}
			setStatus(status, message)
		}()
	}

	header := container.NewVBox()
	if logo := brandingFile("odm-logo-full.svg"); logo != "" {
		image := canvas.NewImageFromFile(logo)
		image.FillMode = canvas.ImageFillContain
		image.SetMinSize(fyne.NewSize(300, 52))
		header.Add(image)
	} else {
		title := widget.NewLabelWithStyle(
			"Open Directory Manager", fyne.TextAlignLeading, fyne.TextStyle{Bold: true},
		)
		header.Add(title)
	}
	header.Add(widget.NewLabel(
		"Joins this machine to the domain, installs its Kerberos keytab and enables the policy agent.",
	))
	header.Add(widget.NewSeparator())

	body := container.NewVBox(
		widget.NewForm(
			widget.NewFormItem("Domain", domain),
			widget.NewFormItem("Domain controller", server),
			widget.NewFormItem("Container", organizationalUnit),
		),
		widget.NewSeparator(),
		method,
		credentialForm,
		tokenForm,
		widget.NewSeparator(),
		joinButton,
		progress,
		status,
		widget.NewLabelWithStyle("Progress", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		logScroll,
	)

	footer := widget.NewLabel("odm-join-gui " + version)

	return container.NewPadded(
		container.NewBorder(header, footer, nil, nil, container.NewVScroll(body)),
	)
}

// Fyne requires widget updates on the main thread.
func runOnMain(work func()) {
	fyne.Do(work)
}

func setStatus(label *widget.Label, text string) {
	runOnMain(func() { label.SetText(text) })
}

func setText(label *widget.Label, text string) {
	runOnMain(func() { label.SetText(text) })
}
