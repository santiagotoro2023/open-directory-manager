import { Details, Note, PageLink, Quickstart, Reference, Section } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "why-odm",
  title: "Why Open Directory Manager",
  section: "Start here",
  summary:
    "What ODM is for, what it replaces, and why a business can run its whole managed environment on Linux without hiring a specialist for every small thing.",
  keywords: [
    "why", "value", "pitch", "open source", "migrate", "windows", "active directory", "cost",
    "privacy", "licensing", "vendor lock-in", "small business", "school", "scale", "overview",
  ],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          Open Directory Manager is the one place a business runs its computers from: who may sign
          in, to what, with which rules on each machine, which software they have, which printers
          and network drives appear, how they prove who they are, and what happened while nobody
          was looking. It does for a Linux fleet what Active Directory, Group Policy and a shelf of
          Microsoft management products do for a Windows one &mdash; in a single console, with the
          words an administrator already knows, and without a licence for any of it.
        </p>
        <p>
          It is open source. Every line of it can be read, every decision it makes can be audited,
          and nothing it does phones home. The directory it manages is a real, standards-based
          domain, so a business is never locked to ODM either: every client that speaks the
          Kerberos and LDAP the world standardised on twenty years ago can join it.
        </p>
      </Quickstart>

      <Details>
        <Section title="The problem it solves">
          <p>
            Most businesses that want to leave Windows do not stay on it because they love it.
            They stay because managing a hundred computers without Active Directory is a hundred
            separate machines: a password changed on one, a printer added by hand on the next, an
            update forgotten on the third, and no way of knowing who signed in where. The tools
            that solve this on Linux exist, but as a dozen separate projects, each with its own
            configuration file, its own vocabulary and its own specialist &mdash; and stitching
            them together has meant either writing an in-house toolkit nobody else can maintain
            or hiring somebody expensive to fix every small thing.
          </p>
          <p>
            ODM stitches them together once, for everyone. A Samba domain controller, SSSD on the
            clients, Kerberos, the browsers&rsquo; own policy files, systemd, nftables, CUPS, Kea,
            FreeRADIUS, WireGuard, xrdp &mdash; each proven, each already trusted by the people who
            audit such things &mdash; are driven from one console by one agent, and the operator
            sees one thing: the domain, its people, its machines and its rules.
          </p>
        </Section>

        <Section title="Built for people who know Windows">
          <p>
            The console speaks Active Directory: Organizational Units, Group Policy Objects,
            security groups, distinguished names, item-level targeting, enforced links, blocked
            inheritance. An administrator who has run Active Directory Users and Computers and the
            Group Policy Management Console finds their way around in minutes, and a domain built
            with ODM looks, to a Windows client or to RSAT, like the domain it is. The move to
            Linux does not have to be a move to a different way of thinking.
          </p>
        </Section>

        <Section title="What it does, in one place">
          <Reference
            headers={["You want to", "ODM gives you"]}
            rows={[
              [
                "Manage people, groups and machines",
                "A directory with organizational units, users, groups, computers; bulk import; groups whose membership is a query; one action that offboards a leaver; a recycle bin for anything deleted.",
              ],
              [
                "Decide how every machine behaves",
                "Group Policy that Debian clients actually enforce: drive maps, printers, browser policy, wallpaper, sudo rights, who may sign in where, files, scripts, services, cron, firewall, updates, software to install or forbid, certificates, Wi-Fi, boot splash, power and screen lock, a local administrator whose password rotates itself — with precedence, inheritance and targeting the way Active Directory does them.",
              ],
              [
                "Prove who is signing in",
                "A second factor at the machine itself — at the screen, over SSH, at sudo, over remote desktop — as a code or as a tap on a phone through a notification server the domain runs itself, with the phone app shipped in every release.",
              ],
              [
                "Give people their files, printers and desktops",
                "File shares, printers found on the network and handed out by policy, roaming profiles that follow a person between desks, remote desktop collections behind a broker, connection files that arrive on the desktop.",
              ],
              [
                "Run the network",
                "DNS and DHCP with failover, a certificate authority that trusts and enrols every machine automatically, RADIUS for 802.1X wired and wireless access, WireGuard for people outside, unattended installation that joins the domain on first boot.",
              ],
              [
                "Know what is happening",
                "Monitoring with rules, alerts to a phone or a webhook, maintenance windows and dashboards for a screen on a wall; an activity feed of every sign-in, every sudo, every USB device on every machine; an audit log of every change anyone made through the console.",
              ],
              [
                "Fix something now",
                "A root terminal on any machine from its own page, a file browser, a remote screen with the person's consent, updates and restarts — all recorded, all within a second of the click.",
              ],
              [
                "Let the helpdesk help without handing over the keys",
                "Delegation: roles scoped to an organizational unit, so somebody may reset passwords in one department and nothing else, and a read-only role that sees everything and changes nothing.",
              ],
            ]}
          />
        </Section>

        <Section title="Why it is cheaper than it looks">
          <p>
            There is no licence. Not per user, not per device, not per server, not per year. A
            Windows domain of a hundred people pays for Windows, for the server, for client access,
            for the management suite, for the antivirus console, for the monitoring product, for
            the remote-support product &mdash; and again next year. ODM and everything under it is
            free software, and the money that used to go to renewals goes to hardware, to people,
            or to nothing at all.
          </p>
          <p>
            The larger saving is people. A small business cannot afford a Linux specialist for
            every corner &mdash; one who knows SSSD, one who knows PAM, one who knows nftables, one
            who knows FreeRADIUS. With ODM, the person who knows the console knows the fleet. The
            specialists&rsquo; knowledge is in the product, applied the same way on every machine,
            and the console says what it did and why when something goes wrong. The wiki you are
            reading is part of that: every setting is explained, and every failure that has ever
            been seen has a page.
          </p>
        </Section>

        <Section title="Your data stays yours">
          <p>
            Nothing in ODM talks to anyone but you. The directory, the passwords, the logs, the
            second-factor server, the certificate authority, the monitoring data &mdash; all of it
            runs on machines you own, in a building you can walk into. There is no telemetry, no
            cloud account, no vendor who can read what your people did today or decide tomorrow
            that a feature now costs extra. For a business that has grown uneasy about how much of
            its digital life a single supplier can see, that is not a feature; it is the point.
          </p>
          <p>
            Because it is open source, that claim can be checked rather than trusted. And because
            the domain underneath is a standard one, leaving ODM later &mdash; should a business
            ever want to &mdash; means keeping the directory and choosing another way to run it,
            not starting again.
          </p>
        </Section>

        <Section title="Grows with the business">
          <p>
            A domain starts as one controller in a cupboard and three laptops. Every role ODM adds
            &mdash; file server, printing, DHCP, remote desktop, VPN, RADIUS, monitoring &mdash;
            is installed from the console onto any joined machine when it is needed, not before.
            A second controller replicates the directory; a second DHCP node pairs with the first;
            session hosts join a collection behind a broker as more people work remotely; sites
            and subnets tell machines which controller is near them. Nothing is redesigned when
            the company doubles; another machine is joined and another role is switched on.
          </p>
        </Section>

        <Section title="Honest about what it is">
          <p>
            ODM manages Debian machines &mdash; desktops, laptops, servers &mdash; from a Debian
            controller. It does not run Windows applications; a business that depends on one still
            needs a way to run it, and remote desktop to a Windows host is one ODM can hand out. It
            is young software with a small team, which is a reason to read its audit log and its
            tests, both of which are public, and to try it on a lab before a fleet.
          </p>
          <Note>
            The <PageLink page="quickstart">Quickstart</PageLink> takes a first domain from an
            empty machine to a joined client in an afternoon. The rest of this wiki explains every
            page of the console, every policy setting, and what to do when something does not go
            as expected.
          </Note>
        </Section>
      </Details>
    </>
  );
}
