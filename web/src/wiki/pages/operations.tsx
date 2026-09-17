import {
  C,
  Code,
  Details,
  Example,
  Note,
  Quickstart,
  Reference,
  Section,
  Steps,
  Where,
} from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "operations",
  title: "Health and backups",
  section: "Administration",
  summary: "Health, replication between domain controllers, and domain backups.",
  keywords: [
    "health",
    "replication",
    "drs",
    "backup",
    "restore",
    "monitoring",
    "dashboard",
    "export",
    "import",
    "configuration",
    "migration",
  ],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          The Overview answers three questions: is the domain well, are the controllers in step, and
          when was the last backup.
        </p>

        <Example title="Check the domain">
          <strong>Overview</strong> → <strong>Health</strong>. Each card reports one subsystem and
          says so plainly when that subsystem is not installed.
        </Example>
        <Example title="Force replication">
          <strong>Replication</strong> → the row for a partnership → <strong>Replicate now</strong>.
        </Example>
        <Example title="Take a backup">
          <strong>Backups</strong> → <strong>Back up now</strong>. It runs in the background and
          appears in the list when it finishes.
        </Example>
        <Example title="Write the whole configuration to a file">
          <strong>Configuration</strong> → <strong>Download the configuration</strong>. One JSON
          file holding every object, zone and setting in the domain.
        </Example>

        <Where>Overview.</Where>
      </Quickstart>

      <Details>
        <Section title="Health">
          <Reference
            headers={["Card", "Reports"]}
            rows={[
              ["Directory", "How many domain controllers are present, and their names."],
              ["Replication", "Whether every inbound partnership last replicated successfully."],
              [
                "Agents",
                "How many machines have reported, and how many did so recently. Also how many settings are currently failing.",
              ],
              ["DHCP", "Address utilisation per scope, when the role is installed."],
              ["Certificates", "The authority's expiry, and certificates expiring within 30 days."],
              ["Backups", "When the last backup completed and how large it was."],
            ]}
          />
          <p>
            A machine counts as stale when nothing has arrived from it for three refresh intervals.
            Anything counts: a policy run, an inventory, or collecting queued work. Policy already
            applied is not applied again, so a settled machine reports no policy run for as long as
            nothing changes &mdash; and judged on that alone it looked like a machine that had
            never run the agent.
          </p>
        </Section>

        <Section title="Replication">
          <p>
            Every domain controller is listed from its own account, and each inbound partnership
            with its naming context, its partner, the controller that saw it, the last attempt and
            the consecutive failure count.
          </p>
          <p>
            Each controller collects its own replication state with its inventory, because Samba
            answers the call behind <C>samba-tool drs showrepl</C> only to a caller that is itself a
            domain controller or an administrator. So the table appears at a controller&rsquo;s next
            check-in, and <strong>Collected</strong> says how old it is.
          </p>
          <Reference
            headers={["Naming context", "Holds"]}
            rows={[
              [
                <C key="1">DC=corp,DC=example,DC=internal</C>,
                "The domain: users, groups, computers, organizational units.",
              ],
              [
                <C key="2">CN=Configuration,…</C>,
                "Forest configuration: sites, services, partitions.",
              ],
              [<C key="3">CN=Schema,CN=Configuration,…</C>, "The schema."],
              [<C key="4">DC=DomainDnsZones,…</C>, "DNS zones replicated domain-wide."],
              [<C key="5">DC=ForestDnsZones,…</C>, "DNS zones replicated forest-wide."],
            ]}
          />
          <Note>
            A single-controller domain has no partnerships and nothing to replicate. That is
            expected, not a fault.
          </Note>
        </Section>

        <Section title="Upgrading">
          <p>
            Fetch the new version and run setup again on the controller. Steps that already
            completed are skipped, so it upgrades in place: it rebuilds the console, reinstalls the
            control plane, rebuilds the agent, and restarts both. Database migrations run when the
            control plane starts.
          </p>
          <Code>{`cd /path/to/open-directory-manager
sudo git pull
sudo deploy/setup.sh --console-fqdn <this controller's name>`}</Code>
          <Reference
            headers={["Then", "Why"]}
            rows={[
              [
                <C key="u1">systemctl status odm-api odm-agent</C>,
                "Both are restarted by setup; this is what says they came back.",
              ],
              [
                <C key="u2">odm-agent apply --force</C>,
                "Makes this machine check in at once rather than at its next interval, so the console is current.",
              ],
              [
                "Every other domain machine",
                "Its agent keeps working across a control-plane upgrade. Upgrade agents by reinstalling the client package where a change names the agent.",
              ],
            ]}
          />
          <Note>
            A domain already provisioned is never re-provisioned. Setup detects it and skips
            straight to the control plane, the console and the agent.
          </Note>
        </Section>

        <Section title="Backups">
          <p>
            A backup produces one archive holding the directory, SYSVOL and the domain
            configuration. Backups run on a schedule and can be taken on demand.
          </p>
          <Reference
            headers={["Setting", "Meaning"]}
            rows={[
              [
                <C key="1">ODM_BACKUP_DIR</C>,
                "Where archives are written. Unset, backups are unavailable.",
              ],
              [<C key="2">ODM_BACKUP_INTERVAL_HOURS</C>, "Scheduled interval. 24 by default."],
              [<C key="3">ODM_BACKUP_KEEP</C>, "How many archives to keep. 14 by default."],
            ]}
          />
          <p>
            Retention keeps the newest archives and removes the rest. Nothing in the directory that
            is not a backup archive is touched.
          </p>
        </Section>

        <Section title="Security baseline">
          <p>
            <strong>Overview</strong> &rarr; <strong>Security baseline</strong> measures the
            domain against a checklist. Every check reads something ODM already holds and answers
            one question an auditor asks; nothing here changes anything, and each finding says
            where in the console it is fixed.
          </p>
          <Reference
            headers={["Check", "What it looks at"]}
            rows={[
              ["Dormant accounts", "Enabled accounts nobody has signed in with for 90 days."],
              ["Passwords that never expire", "Enabled accounts exempt from password expiry."],
              ["Domain administrators", "How many accounts can administer the whole domain."],
              ["Second factor on administrators", "Which of them sign in with a password alone."],
              ["Machines reporting", "Machines that have not checked in for a day."],
              ["Disk encryption", "Machines reporting no encrypted volume."],
              ["Domain backups", "How long since one completed."],
              ["Certificates expiring", "Certificates due to expire within a month."],
              ["Delegated administration", "Delegations that apply to the whole domain."],
            ]}
          />
          <Note>
            A row with a count opens to show which objects it is about. The read-only role can see
            this page, so an auditor can take the report without being able to change anything.
          </Note>
        </Section>

        <Section title="Phone approvals">
          <p>
            A second factor answered with a tap instead of a typed code. Where a policy&rsquo;s{" "}
            <strong>Second factor</strong> setting says <em>Approval on the phone</em>, signing in
            sends the person&rsquo;s phone an <strong>Approve</strong> / <strong>Deny</strong>{" "}
            notification and waits up to a minute; no answer, or Deny, refuses the sign-in. The
            login screen says &ldquo;Check your phone: approve this sign-in to continue&rdquo;
            while it waits, the way it shows the code prompt for the other method.
          </p>
          <p>
            The notifications go through <strong>ntfy</strong> &mdash; an open notification
            server and app &mdash; which <C>deploy/setup.sh</C> installs on the domain controller
            beside the control plane, on port <C>8444</C>, with the console&rsquo;s own
            certificate. Nothing leaves the domain: no vendor push service, no account with
            anyone. A pinned release is downloaded from ntfy&rsquo;s own GitHub releases and
            verified against its published checksum; a controller without a route to fetch it
            comes up without phone approvals and says so, and{" "}
            <C>deploy/install-phone-approvals.sh --console-fqdn &lt;console&gt;</C> adds them
            later.
          </p>
          <p>
            <strong>Nobody has to visit the console.</strong> The administrator sets the policy;
            everything else happens at the machine, the same way a code is set up. Somebody the
            policy covers who has no phone set up is let in during the grace period and walked
            through it at their next sign-in &mdash; on a text login or over SSH right there, in
            a graphical session in a full-screen window as the desktop starts that cannot be
            clicked away. <strong>The policy is the source of truth:</strong> switching a policy
            from the code to the phone takes everyone&rsquo;s code enrolments away (and the other
            way round), and turning the setting off takes both, so nobody is asked for something
            the policy no longer wants.
          </p>
          <Steps>
            <li>
              Set the policy: <strong>Second factor</strong> &rarr; <strong>How</strong> &rarr;{" "}
              <em>Approval on the phone</em>. Leave the server address empty on the office
              network; see the next section for reaching phones anywhere.
            </li>
            <li>
              At the person&rsquo;s next sign-in the walkthrough shows the server, the topic and,
              with a self-signed console, the certificate&rsquo;s fingerprint. They install the{" "}
              <strong>ntfy</strong> app (1.24 or later), <strong>+</strong> &rarr;{" "}
              <em>Subscribe to topic</em> &rarr; <em>Use another server</em>, enter the two, and
              tap Subscribe. With a self-signed certificate the app says it does not know it,
              shows the fingerprint, and offers <strong>Trust</strong>: one tap, once — the app
              pins that certificate for that server from then on. The store build asks that
              question only in its own subscribe dialog, and a scanned code skips it; the build
              of ntfy attached to every ODM release (<C>ntfy-odm_*.apk</C>, this project's fix,
              offered upstream) asks it on a scanned code too — with that build a person scans
              the code, taps Trust, taps Confirm, and is done. The topic is the secret: sixteen random characters, shown once. It must
              be the app that subscribes — the server has no web page, precisely so a Confirm
              tapped in a browser cannot enrol a phone that is not listening.
            </li>
            <li>
              They tap <strong>Confirm</strong> on the notification that arrives. That tap is
              what finishes enrolling &mdash; the same reason a code enrolment is not finished
              until a code from the device is accepted. Pressing <C>r</C> in the walkthrough
              sends it again.
            </li>
            <li>
              The sign-in completes. From then on: password, then a tap. There is no code behind
              the phone; somebody who loses their phone is reset by an administrator (below) and
              walked through it again.
            </li>
          </Steps>
          <Reference
            headers={["What", "Where"]}
            rows={[
              ["Server", <C key="pa1">/etc/ntfy/server.yml</C>],
              [
                "Its certificate",
                <>
                  <C key="pa5">/etc/odm/tls/phone.crt</C> — the phone server&rsquo;s own, made once
                  from the console&rsquo;s and then left alone, because phones pin the certificate
                  they were shown. Replacing the console&rsquo;s certificate does not change it;
                  a phone never sees &ldquo;the fingerprint has changed&rdquo; for that reason.
                </>,
              ],
              ["Publishing token (root only)", <C key="pa2">/etc/ntfy/odm-token</C>],
              ["Control plane settings", <C key="pa3">ODM_NTFY_* in /etc/odm/odm.env</C>],
              ["Logs", <C key="pa4">journalctl -u ntfy</C>],
              [
                "Every ask and answer",
                "Audit log, actions auth.second_factor.push.begin / .ask / .approved / .denied / .enrol.",
              ],
              [
                "Resetting one person",
                "Right-click the user in Directory → Reset second factor…, or the same button on the user object. Removes their code and their phone; their next sign-in walks them through setting up whatever the policy asks for. The person can also remove their own phone from Second factor under their name in the console.",
              ],
              [
                "Resetting everyone",
                "Overview → Configuration → Reset every second factor. The fresh start for the whole domain, held behind the same right as replacing the domain's configuration.",
              ],
            ]}
          />
          <Note>
            Anyone who knows a topic&rsquo;s name can read it, and nobody but the control plane can
            publish to one: ntfy is configured read-only by default with a single publishing
            account. Approvals travel over TLS only; the plain-HTTP listener exists on the
            loopback address alone, for the control plane on the same machine. (Setting{" "}
            <C key="pl1">ODM_NTFY_PLAIN_URL</C> and opening the listener is possible for a network
            that wants no certificate question at all, and puts every approval on that network in
            the clear — not something to forward through a router.)
          </Note>
          <Note>
            Google Authenticator and similar apps cannot receive these. They are code generators
            with no channel for a server to reach them; only an app built to receive
            notifications can, which is what ntfy is. The console&rsquo;s own Second factor dialog
            can also set a phone up, for somebody who prefers to do it there.
          </Note>
        </Section>

        <Section title="Phone approvals from anywhere">
          <p>
            On the office network a phone reaches the controller by its name. Away from it &mdash;
            on mobile data, at home &mdash; the notification cannot arrive unless the server is
            reachable from the internet. That takes one forwarded port and one policy field, and
            nothing else changes: the topic stays the secret, and publishing stays the control
            plane&rsquo;s alone.
          </p>
          <Steps>
            <li>
              <strong>A name phones can resolve.</strong> A DNS name that points at the
              router&rsquo;s public address: a hostname at the domain&rsquo;s registrar, or a
              dynamic-DNS name if the address changes. Say <C>odm.example.org</C>.
            </li>
            <li>
              <strong>Forward the port.</strong> On the router, forward TCP <C>8444</C> (HTTPS)
              from the internet to the controller&rsquo;s address on the office network, same
              port. Not <C>8445</C>: plain HTTP across the internet would put every approval on
              the open road, so from outside it is HTTPS with a certificate phones trust, or
              nothing. Only that port: the console on <C>8443</C>, LDAP, Kerberos and SMB stay inside. If the
              router does not offer a fixed lease for the controller, give the controller a
              static address first.
            </li>
            <li>
              <strong>The certificate needs no change.</strong> The ntfy app pins the
              certificate it was told to trust and skips hostname checking for a pinned one, so
              the console&rsquo;s self-signed certificate, made for the internal name, works
              through the public address exactly as it does inside. A certificate from a public
              authority (Certificates &rarr; Signing request, then Upload) removes the Trust
              question altogether and lets the walkthrough show a code to scan.
            </li>
            <li>
              <strong>Tell the policy.</strong> <strong>Second factor</strong> &rarr;{" "}
              <strong>Notification server address, as phones reach it</strong> &rarr;{" "}
              <C>https://odm.example.org:8444</C>. From then on the walkthrough shows that
              address, and phones already subscribed keep working because a subscription is a
              server plus a topic &mdash; anyone set up before the change re-adds the
              subscription with the new server, or is walked through it again after removing the
              old one.
            </li>
            <li>
              <strong>Check it from outside.</strong> On a phone on mobile data, open{" "}
              <C>https://odm.example.org:8444/v1/health</C> in the browser: it should answer{" "}
              <C>{"{\"healthy\":true}"}</C>. If it does not, the forward or the name is wrong,
              not ODM.
            </li>
          </Steps>
          <Reference
            headers={["Question", "Answer"]}
            rows={[
              [
                "What is exposed?",
                "ntfy alone, over TLS, on the one port. It accepts subscriptions to any topic name (nobody can guess one), refuses every publish without the control plane's token — except to the answer topics, which anyone may write to but only the control plane may read. The console itself is never exposed for this.",
              ],
              [
                "How does the answer get back?",
                "The Approve and Deny buttons publish one word to a topic named after the sign-in's token, on the same server the phone already reaches. The control plane reads it from inside. A token answers exactly one sign-in, once, within a minute.",
              ],
              [
                "Can the address be an IP?",
                "Yes, https://203.0.113.5:8444 works, but a certificate is issued to a name, so a name is what the phone will trust cleanly.",
              ],
              [
                "Two controllers?",
                "Phone approvals live on the controller the control plane runs on. Forward to that one.",
              ],
            ]}
          />
          <Note>
            Forward 8444 and nothing else. The console on 8443, LDAP, Kerberos and SMB have no
            part in this and stay inside.
          </Note>
        </Section>

        <Section title="Configuration export">
          <p>
            <strong>Overview</strong> → <strong>Configuration</strong> →{" "}
            <strong>Download the configuration</strong> writes one file holding everything this
            domain is configured to be: every organizational unit, group, user and computer; every
            DNS zone and the records in it; and everything ODM keeps on top of them &mdash; policy
            objects and their settings, links and precedence, shares, printers, DHCP scopes, remote
            desktop collections, sites, certificate profiles, roles, delegations and password
            policy.
          </p>
          <p>
            The file is readable JSON. It is enough to rebuild the domain on a machine that has
            never seen this one, and enough for somebody to see every setting without being given
            access to the running system.
          </p>
          <Reference
            headers={["In the file", "Not in the file"]}
            rows={[
              [
                "Every directory object, with its attributes and group memberships",
                "Password hashes. The directory does not hand them out.",
              ],
              [
                "Every DNS zone and record",
                "Private keys: the certificate authority's, and each VPN tunnel's and peer's.",
              ],
              [
                "Every policy object, its settings, its links and their order",
                "RADIUS shared secrets, and rotated local-administrator passwords.",
              ],
              [
                "Shares, printers, scopes, collections, roles, delegations, sites",
                "Join tokens and second-factor enrolments.",
              ],
              [
                "Which secrets were withheld, and how many of each",
                "The audit log, the task queue, sign-in attempts and reported machine facts.",
              ],
            ]}
          />
          <Note>
            An export is a document that gets copied, mailed and attached to a support request.
            Credentials are left out so that producing one never hands over access to the domain it
            describes. An import regenerates or asks for each.
          </Note>
        </Section>

        <Section title="Configuration import">
          <p>
            An import makes this domain the one in the file. ODM&rsquo;s own store is replaced
            wholesale and every object in the file is created in the directory, with distinguished
            names rebased onto this domain &mdash; so an export from{" "}
            <C>corp.example.internal</C> imports into a domain of another name.
          </p>
          <Steps>
            <li>
              <strong>Overview</strong> → <strong>Configuration</strong> → choose the file. Nothing
              is written yet: the console first says what the file holds.
            </li>
            <li>
              Read the summary, then type <C>import</C> to confirm.
            </li>
            <li>
              What could not be recreated is listed afterwards, and every step is in the audit log.
            </li>
          </Steps>
          <p>
            At install time instead, <C>deploy/setup.sh --import &lt;file&gt;</C> does the same
            thing once the console is up, so a new domain comes up already configured. The same
            step can be run later with <C>deploy/import-configuration.py</C>.
          </p>
          <Example title="Bring up a domain from an export">
            <Code>{`sudo deploy/setup.sh --realm corp.example.internal \\
    --netbios EXAMPLE --import /root/odm-corp.example.internal.json`}</Code>
          </Example>
          <Note>
            Accounts come back disabled and without a password, because the export never carried
            one. Set a password and enable each account, or have people enrol again.
          </Note>
          <Note>
            This is not a substitute for a backup. A backup restores this domain, with its
            identifiers and password hashes intact; an import builds a domain configured the same
            way, whose accounts are new accounts. Use a backup to recover this domain and an import
            to build another like it.
          </Note>
        </Section>

        <Section title="Restore drill">
          <p>
            Restoring a domain is a deliberate operation performed on the controller, not from a web
            interface. The archives are the input to the standard Samba restore.
          </p>
          <Steps>
            <li>Stop the domain controller service on the target machine.</li>
            <li>Move the existing directory state aside rather than deleting it.</li>
            <li>
              Restore the archive with <C>samba-tool domain backup restore</C>, giving the target
              directory and the new server name.
            </li>
            <li>Put the restored Kerberos configuration in place and start the service.</li>
            <li>
              Verify: the domain functional level reports, service records resolve, and a domain
              account can obtain a ticket.
            </li>
            <li>Re-point the control plane at the restored controller and confirm sign-in.</li>
          </Steps>
          <Note>
            Practise this on a machine that is not serving the domain. A restore rewrites directory
            state; rehearsing it is what makes it usable when it is needed.
          </Note>
        </Section>
      </Details>
    </>
  );
}
