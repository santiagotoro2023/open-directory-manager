import { C, Code, Details, Example, Note, Quickstart, Reference, Section, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "policy-settings",
  title: "Policy settings",
  section: "Managing the domain",
  summary: "Every setting category a policy object can carry, and what each one does on a client.",
  keywords: [
    "files", "scripts", "systemd", "cron", "firewall", "drive map", "sudo", "hbac",
    "wallpaper", "browser", "trusted certificates", "nftables", "pam",
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
          <strong>File deployment</strong> → <strong>Add</strong> → path{" "}
          <C>/etc/motd</C>, content, mode <C>0644</C>.
        </Example>
        <Example title="Turn a service off everywhere">
          <strong>systemd units</strong> → <strong>Add</strong> → unit{" "}
          <C>telnet.socket</C>, state <C>masked</C>.
        </Example>
        <Example title="Give a group sudo rights">
          <strong>Sudo rules</strong> → users <C>%Helpdesk</C>, commands{" "}
          <C>/usr/bin/systemctl</C>, NOPASSWD ticked.
        </Example>
        <Example title="Restrict who may log in">
          <strong>HBAC rules</strong> → principal <C>%Engineers</C>, service{" "}
          <C>ssh</C>, access <C>allow</C>. Root and local administrators are always kept.
        </Example>

        <Where>Group Policy → select a policy object → Settings.</Where>
      </Quickstart>

      <Details>
        <Section title="Categories at a glance">
          <Reference
            headers={["Category", "Merged by", "Result on the client"]}
            rows={[
              ["File deployment", "path", "The file is written with the given mode, owner and group."],
              ["Scripts", "trigger and name", "Executable scripts run at startup, shutdown, logon or logoff."],
              ["systemd units", "unit", "A unit is enabled, disabled, masked, started or stopped."],
              ["Scheduled tasks", "name", "An entry in /etc/cron.d."],
              ["Firewall rules", "name", "Rules in a dedicated nftables table."],
              ["Drive maps", "mount point", "A mounted SMB share, machine-wide or per user."],
              ["Sudo rules", "name", "A file in /etc/sudoers.d."],
              ["HBAC rules", "principal and service", "Session access through PAM and sshd."],
              ["Trusted certificates", "name", "A trust anchor in the system certificate store."],
              ["Desktop background", "single value", "A locked GNOME background."],
              ["Browser policy", "per key", "Managed policy for Chromium, Chrome and Firefox."],
              ["Administrative templates", "policy identifier", "Settings from imported vendor templates."],
            ]}
          />
        </Section>

        <Section title="File deployment">
          <Reference
            headers={["Field", "Notes"]}
            rows={[
              ["Path", "Absolute, no path traversal."],
              ["Content", "Written verbatim."],
              ["Mode", <>Octal, for example <C key="m">0644</C>.</>],
              ["Owner, Group", "Resolved on the client at apply time."],
            ]}
          />
          <p>
            Writes are atomic. Removing an entry from the policy removes the file it produced on
            the next apply.
          </p>
        </Section>

        <Section title="Scripts">
          <Reference
            headers={["Trigger", "When it runs"]}
            rows={[
              ["startup", "System start, from the odm-scripts service."],
              ["shutdown", "System stop, from the same unit."],
              ["logon", "Session open, from a PAM hook, covering console, SSH and display manager."],
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

        <Section title="Firewall rules">
          <p>
            Rules are compiled into a dedicated <C>inet odm</C> nftables table that is replaced as
            a unit, and loaded at boot by a generated service. Rules another tool owns are not
            touched.
          </p>
          <Reference
            headers={["Field", "Values"]}
            rows={[
              ["Action", "allow, deny"],
              ["Direction", "in, out"],
              ["Protocol", "tcp, udp, icmp, any"],
              ["Port", "1–65535, for tcp and udp"],
              ["Source", <>An address or CIDR range, or <C key="s">any</C>.</>],
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
              [
                "A user or %group",
                "A pam_mount volume, mounted when that principal logs in.",
              ],
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
              ["Users", <>Comma separated. Prefix a group with <C key="p">%</C>.</>],
              ["Commands", <>Absolute paths, or <C key="c">ALL</C>.</>],
              ["Run as", <>The target user. Defaults to <C key="r">ALL</C>.</>],
              ["NOPASSWD", "Runs without re-authenticating."],
            ]}
          />
        </Section>

        <Section title="HBAC rules">
          <p>
            Host-based access control decides who may open a session on a machine and through
            which service. Rules are written as a managed block in{" "}
            <C>/etc/security/access.conf</C> for PAM, plus an sshd drop-in for SSH.
          </p>
          <Reference
            headers={["Field", "Values"]}
            rows={[
              ["Principal", <>A user name, or a group prefixed with <C key="p">%</C>.</>],
              ["Service", "local, ssh, rdp, all"],
              ["Access", "allow, deny"],
            ]}
          />
          <Note>
            Deny overrides allow: every deny rule is written before any allow rule, and the first
            match wins. When at least one allow rule exists, a closing deny is added — and{" "}
            <C>root</C> and the local administrators group are always allowed before it, so a
            policy mistake cannot lock everyone out of a machine.
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
            Written as a dconf system database with the keys locked, then{" "}
            <C>dconf update</C>. The image must already be present on the client — deploy it with a
            file entry in the same policy object.
          </p>
        </Section>

        <Section title="Browser policy">
          <p>
            Chromium and Chrome read managed policy from{" "}
            <C>/etc/chromium/policies/managed</C> and <C>/etc/opt/chrome/policies/managed</C>;
            Firefox reads <C>/etc/firefox/policies/policies.json</C>. Keys can be written directly,
            or produced by importing a vendor administrative template.
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
