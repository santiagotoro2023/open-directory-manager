import {
  C,
  Code,
  Details,
  Example,
  Note,
  Quickstart,
  Reference,
  Section,
  Where,
} from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "policy-settings",
  title: "Policy settings",
  section: "Managing the domain",
  summary: "Every setting category a policy object can carry, and what each one does on a client.",
  keywords: [
    "files",
    "scripts",
    "systemd",
    "cron",
    "firewall",
    "drive map",
    "sudo",
    "hbac",
    "wallpaper",
    "browser",
    "trusted certificates",
    "nftables",
    "pam",
  ],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          A policy object carries one or more setting categories. Each category is a list of
          entries, edited on the <strong>Settings</strong> tab. Entries from different policy
          objects merge by their identity — a file by its path, a unit by its name — and the policy
          applied last wins for that entry.
        </p>

        <Example title="Deploy a file to every machine">
          <strong>File deployment</strong> → <strong>Add</strong> → path <C>/etc/motd</C>, content,
          mode <C>0644</C>.
        </Example>
        <Example title="Turn a service off everywhere">
          <strong>systemd units</strong> → <strong>Add</strong> → unit <C>telnet.socket</C>, state{" "}
          <C>masked</C>.
        </Example>
        <Example title="Give a group sudo rights">
          <strong>Sudo rules</strong> → users <C>%Helpdesk</C>, commands <C>/usr/bin/systemctl</C>,
          NOPASSWD ticked.
        </Example>
        <Example title="Install software everywhere">
          <strong>Software deployment</strong> → <strong>Add</strong> → package <C>cifs-utils</C>,
          state <C>present</C>.
        </Example>
        <Example title="Keep machines patched">
          <strong>System updates</strong> → <strong>Add</strong> → security updates only, daily.
          Tick <strong>Restart the machine when an update needs it</strong> for servers that can
          take it.
        </Example>
        <Example title="Put a message on the login screen">
          <strong>Login screen</strong> → <strong>Add</strong> → a message, and a background image
          if wanted. This is the greeter, before anyone signs in — separate from the desktop
          background, which belongs to whoever is signed in.
        </Example>
        <Example title="Give people a printer">
          <strong>User</strong> → <strong>Printers</strong> → <strong>Add</strong> → the printer and
          its server, then the group with <strong>Select…</strong>.
        </Example>
        <Example title="Restrict who may log in">
          <strong>HBAC rules</strong> → principal <C>%Engineers</C>, service <C>ssh</C>, access{" "}
          <C>allow</C>. Root and local administrators are always kept.
        </Example>

        <Where>Group Policy → select a policy object → Settings.</Where>
      </Quickstart>

      <Details>
        <Section title="Categories at a glance">
          <Reference
            headers={["Category", "Merged by", "Result on the client"]}
            rows={[
              [
                "File deployment",
                "path",
                "The file is written with the given mode, owner and group.",
              ],
              [
                "Scripts",
                "trigger and name",
                "Executable scripts run at startup, shutdown, logon or logoff.",
              ],
              ["systemd units", "unit", "A unit is enabled, disabled, masked, started or stopped."],
              ["Scheduled tasks", "name", "An entry in /etc/cron.d."],
              [
                "Software deployment",
                "package name",
                "An apt package installed, upgraded or removed.",
              ],
              [
                "System updates",
                "single value",
                "Unattended apt upgrades, through unattended-upgrades.",
              ],
              [
                "Login screen",
                "single value",
                "The greeter's message, background and account list.",
              ],
              [
                "Local administrator",
                "single value",
                "A local account whose password the machine generates and rotates itself.",
              ],
              [
                "Printers",
                "printer and principal",
                "A printer from a print server, offered to a user or group.",
              ],
              [
                "Local administrator",
                "Computer",
                "A local account whose password the machine rotates itself (LAPS).",
              ],
              ["Always-on VPN", "single value", "A tunnel the machine holds up from boot."],
              [
                "Certificates",
                "kind and path",
                "A certificate the machine gets by itself and renews.",
              ],
              [
                "Self-service password",
                "single value",
                "Whether people may change their own password.",
              ],
              ["Firewall rules", "name", "Rules in a dedicated nftables table."],
              ["Drive maps", "mount point", "A mounted SMB share, machine-wide or per user."],
              ["Sudo rules", "name", "A file in /etc/sudoers.d."],
              ["HBAC rules", "principal and service", "Session access through PAM and sshd."],
              ["Trusted certificates", "name", "A trust anchor in the system certificate store."],
              ["Desktop background", "single value", "A locked GNOME background."],
              ["Browser policy", "per key", "Managed policy for Chromium, Chrome and Firefox."],
              [
                "Administrative templates",
                "policy identifier",
                "Settings from imported vendor templates.",
              ],
            ]}
          />
        </Section>

        <Section title="File deployment">
          <Reference
            headers={["Field", "Notes"]}
            rows={[
              ["Path", "Absolute, no path traversal."],
              ["Content", "Written verbatim."],
              [
                "Mode",
                <>
                  Octal, for example <C key="m">0644</C>.
                </>,
              ],
              ["Owner, Group", "Resolved on the client at apply time."],
            ]}
          />
          <p>
            Writes are atomic. Removing an entry from the policy removes the file it produced on the
            next apply.
          </p>
        </Section>

        <Section title="Scripts">
          <Reference
            headers={["Trigger", "When it runs"]}
            rows={[
              ["startup", "System start, from the odm-scripts service."],
              ["shutdown", "System stop, from the same unit."],
              [
                "logon",
                "Session open, from a PAM hook, covering console, SSH and display manager.",
              ],
              ["logoff", "Session close, from the same hook."],
            ]}
          />
          <p>
            Scripts are written to <C>/etc/odm/scripts/&lt;trigger&gt;/&lt;name&gt;</C> with mode{" "}
            <C>0700</C> and the interpreter given as the shebang.
          </p>
        </Section>

        <Section title="systemd units">
          <Reference
            headers={["State", "Commands run"]}
            rows={[
              ["enabled", "unmask, then enable --now"],
              ["disabled", "disable --now"],
              ["masked", "mask --now"],
              ["started", "start"],
              ["stopped", "stop"],
            ]}
          />
        </Section>

        <Section title="Scheduled tasks">
          <p>
            Each entry becomes a file in <C>/etc/cron.d</C>. The schedule is five cron fields or an{" "}
            <C>@</C> keyword. Dots in names are replaced, because cron ignores files whose names
            contain one.
          </p>
          <Code>{`name      nightly-trim
schedule  0 3 * * 0
command   /usr/sbin/fstrim -a
user      root`}</Code>
        </Section>

        <Section title="Targeting one entry rather than the whole object">
          <p>
            A drive map for laptops and another for desks is one policy object in Active Directory,
            not two. Entries in File deployment, Scripts, systemd units, Scheduled tasks, Drive
            maps, Printers and Software deployment each carry an <strong>Applies to</strong> column:{" "}
            <C>Everyone</C> means whoever the policy object reaches, and anything set there narrows
            it further.
          </p>
          <Note>
            The fields are the policy object&rsquo;s own — operating system, host name pattern,
            groups, address ranges — so what &ldquo;matches&rdquo; means does not depend on where it
            is written. Entry targeting can only narrow: an entry cannot reach a machine the policy
            object itself does not.
          </Note>
        </Section>

        <Section title="Login screen and desktop background">
          <p>
            Two separate settings, because they answer different questions. The login screen is a
            machine setting: nobody is signed in yet, so there is no user whose policy could carry
            it. The desktop background is a user setting, applied when they sign in.
          </p>
          <Reference
            headers={["Setting", "Where it lands"]}
            rows={[
              [
                "Login screen message",
                <>
                  <C key="a">banner-message-text</C> in the greeter&rsquo;s own dconf database. An
                  empty message is written as off, so removing one takes it off the screen.
                </>,
              ],
              [
                "Login screen background",
                "A stylesheet for the greeter: GNOME takes the greeter's image from its theme rather than from a dconf value.",
              ],
              [
                "Hide the list of accounts",
                "People type their name instead of picking it, so account names are not on display.",
              ],
              [
                "Let people change their own desktop background",
                <>
                  Whether the background keys are locked. Unticked writes a dconf lock; ticked
                  removes it. Setting a background and forbidding a different one are separate
                  decisions, so they are separate ticks.
                </>,
              ],
            ]}
          />
        </Section>

        <Section title="Always-on VPN">
          <p>
            The machine brings the tunnel up at boot, before anyone signs in, and cannot be told not
            to. The configuration is attached by the control plane for the machine asking — it
            contains a private key belonging to that machine alone, so it is never part of the
            policy object itself. A machine with no peer on the tunnel is reported as skipped rather
            than given something that cannot work.
          </p>
        </Section>

        <Section title="Local administrator">
          <p>
            A local account on every machine the policy reaches, with a password the machine
            generates and rotates itself. Active Directory calls this LAPS. It is the way in when
            the domain is unreachable &mdash; a broken join, a laptop off the network, DNS gone
            &mdash; and because each machine picks its own password, one recovered from a stolen
            machine opens nothing else.
          </p>
          <Reference
            headers={["Setting", "Means"]}
            rows={[
              ["Account name", "Created if it does not exist. Lower case, no spaces."],
              [
                "Rotate every",
                "Days between rotations. A machine also rotates the first time the policy reaches it.",
              ],
              [
                "Password length",
                "Generated from characters that cannot be misread: no O/0, no l/1.",
              ],
              [
                "May use sudo",
                "Off makes the account a way in but not a way up, which is enough to reach a machine and read its logs.",
              ],
            ]}
          />
          <Note>
            The password is never in the policy object and never leaves the machine except in its
            authenticated report. Read it at <strong>Directory</strong> &rarr; the computer &rarr;{" "}
            <strong>Machine</strong>. Every read is written to the audit log, because this is the
            credential that opens the machine.
          </Note>
        </Section>

        <Section title="System updates">
          <p>
            Written as the two files <C>unattended-upgrades</C> reads, and the package is installed
            if it is missing. Security-only is the default: everything else can change behaviour on
            a machine nobody is watching. Turning the setting off removes the files ODM wrote rather
            than writing &ldquo;off&rdquo; into them, so the machine&rsquo;s own setting takes over
            again.
          </p>
          <Reference
            headers={["Setting", "Effect"]}
            rows={[
              ["What to install", "Security origins only, or every available update."],
              ["How often", "Daily or weekly, as APT::Periodic intervals."],
              ["Remove packages nothing needs", "Unattended-Upgrade::Remove-Unused-Dependencies."],
              ["Restart when needed", "Automatic-Reboot, at the time given."],
            ]}
          />
          <Note>
            A one-off update on a single machine is not a policy: use{" "}
            <strong>Check for updates</strong> and <strong>Install updates</strong> on the
            computer&rsquo;s own page.
          </Note>
        </Section>

        <Section title="Software deployment">
          <p>
            Packages are collected across the whole effective policy and applied in one run: the
            index is refreshed once, then one install, one upgrade and one removal command.
          </p>
          <Reference
            headers={["State", "Effect"]}
            rows={[
              ["present", "Installed if it is not already. Not upgraded."],
              ["latest", "Installed, and upgraded to the newest available version each run."],
              ["absent", "Removed if present."],
            ]}
          />
          <p>
            Package names are validated as Debian package names. Nothing the policy did not name is
            installed or removed, and no package is upgraded unless its state says so.
          </p>
        </Section>

        <Section title="Firewall rules">
          <p>
            Rules are compiled into a dedicated <C>inet odm</C> nftables table that is replaced as a
            unit, and loaded at boot by a generated service. Rules another tool owns are not
            touched.
          </p>
          <Reference
            headers={["Field", "Values"]}
            rows={[
              ["Action", "allow, deny"],
              ["Direction", "in, out"],
              ["Protocol", "tcp, udp, icmp, any"],
              ["Port", "1–65535, for tcp and udp"],
              [
                "Source",
                <>
                  An address or CIDR range, or <C key="s">any</C>.
                </>,
              ],
            ]}
          />
        </Section>

        <Section title="Drive maps">
          <p>
            Shares are mounted with <C>cifs</C> and <C>sec=krb5</C>. No credential is stored on a
            client; access uses the Kerberos ticket the session already holds.
          </p>
          <Reference
            headers={["For", "Mechanism"]}
            rows={[
              [
                "No principal set",
                "A systemd .mount plus .automount, mounted on first access rather than at boot.",
              ],
              ["A user or %group", "Mounted only when that user, or a member of that group, signs in."],
            ]}
          />
          <Code>{`name          shared
unc           //fs01/shared
mount point   /mnt/shared
for           %Engineers      (optional)`}</Code>
        </Section>

        <Section title="Sudo rules">
          <p>
            Each rule becomes a file in <C>/etc/sudoers.d</C>. A candidate is validated with{" "}
            <C>visudo</C> outside that directory first, so a rule that would not parse is never
            installed.
          </p>
          <Reference
            headers={["Field", "Notes"]}
            rows={[
              [
                "Users",
                <>
                  Comma separated. Prefix a group with <C key="p">%</C>.
                </>,
              ],
              [
                "Commands",
                <>
                  Absolute paths, or <C key="c">ALL</C>.
                </>,
              ],
              [
                "Run as",
                <>
                  The target user. Defaults to <C key="r">ALL</C>.
                </>,
              ],
              ["NOPASSWD", "Runs without re-authenticating."],
            ]}
          />
        </Section>

        <Section title="HBAC rules">
          <p>
            Host-based access control decides who may open a session on a machine and through which
            service. Rules are written as a managed block in <C>/etc/security/access.conf</C> for
            PAM, plus an sshd drop-in for SSH.
          </p>
          <Reference
            headers={["Field", "Values"]}
            rows={[
              [
                "Principal",
                <>
                  A user name, or a group prefixed with <C key="p">%</C>.
                </>,
              ],
              ["Service", "local, ssh, rdp, all"],
              ["Access", "allow, deny"],
            ]}
          />
          <Note>
            Deny overrides allow: every deny rule is written before any allow rule, and the first
            match wins. When at least one allow rule exists, a closing deny is added — and{" "}
            <C>root</C> and the local administrators group are always allowed before it, so a policy
            mistake cannot lock everyone out of a machine.
          </Note>
        </Section>

        <Section title="Trusted certificates">
          <p>
            A PEM certificate is installed as a trust anchor in{" "}
            <C>/usr/local/share/ca-certificates</C> and the bundle is rebuilt with{" "}
            <C>update-ca-certificates</C>. A payload carrying a private key is refused.
          </p>
        </Section>

        <Section title="Desktop background">
          <p>
            Written as a dconf system database with the keys locked, then <C>dconf update</C>. The
            image must already be present on the client — deploy it with a file entry in the same
            policy object.
          </p>
        </Section>

        <Section title="Browser policy">
          <p>
            Chromium and Chrome read managed policy from <C>/etc/chromium/policies/managed</C> and{" "}
            <C>/etc/opt/chrome/policies/managed</C>; Firefox reads{" "}
            <C>/etc/firefox/policies/policies.json</C>. Keys can be written directly, or produced by
            importing a vendor administrative template.
          </p>
        </Section>

        <Section title="Agent settings">
          <p>
            The refresh interval a machine uses is itself policy. Setting it in a policy object
            overrides the control plane default for the machines that object applies to.
          </p>
        </Section>
      </Details>
    </>
  );
}
