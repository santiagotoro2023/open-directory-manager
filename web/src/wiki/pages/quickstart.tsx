import { C, Code, Details, Example, Note, Quickstart, Reference, Section, Steps, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "quickstart",
  title: "Quickstart",
  section: "Start here",
  summary: "The whole system in one page: bring-up, first objects, first policy, first client.",
  keywords: ["getting started", "setup", "install", "first steps", "overview", "tour"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          Open Directory Manager runs a Windows-compatible directory domain on Linux. A Samba domain
          controller holds the directory, Kerberos, DNS and SYSVOL. The ODM control plane is the
          only thing that talks to it, and this console is the only thing that talks to the
          control plane. Domain members run a small agent that applies the policy the control
          plane resolves for them.
        </p>

        <Section title="Get to a working domain">
          <p>
            On a fresh Debian 12 or 13 server, one command does the whole install and finishes by
            printing the address to sign in at.
          </p>
          <Code>{`git clone https://github.com/santiagotoro2023/open-directory-manager.git
cd open-directory-manager
sudo deploy/setup.sh`}</Code>
          <p>
            It asks what to call the domain, sets the machine&rsquo;s fully-qualified name if it
            does not have one, provisions the domain controller, installs the control plane, sets
            up TLS and the database, builds this console and starts everything. Run it again at
            any point; completed steps are skipped.
          </p>
          <Steps>
            <li>Sign in as a member of the domain administrators group.</li>
            <li>
              <strong>Group Policy</strong> → create the default policies.
            </li>
            <li>
              <strong>Directory</strong> → build the organizational unit structure, then add
              users, groups and computers.
            </li>
            <li>Join the first client and confirm its policy report arrives.</li>
          </Steps>
        </Section>

        <Section title="Do the five things that matter">
          <Example title="Create a user">
            <strong>Directory</strong> → pick an organizational unit → <strong>New user</strong>.
            Give an account name and a password. Without a password the account is created
            disabled.
          </Example>
          <Example title="Group a set of users">
            <strong>Directory</strong> → <strong>New group</strong> → add members from the
            group&rsquo;s <strong>Members</strong> button in the detail panel.
          </Example>
          <Example title="Push a setting to every machine">
            <strong>Group Policy</strong> → <strong>New GPO</strong> → <strong>Settings</strong> →
            add a file deployment → <strong>Links</strong> → link it to an organizational unit.
          </Example>
          <Example title="Join a machine">
            On the client: <C>odm-client-install --domain corp.example.internal</C>. It joins the
            domain, installs the machine keytab and enables the policy agent.
          </Example>
          <Example title="See what a machine actually got">
            <strong>Directory</strong> → select the computer → <strong>Policy</strong>. The dialog
            shows which policy objects applied, which did not and why, the effective settings, and
            the machine&rsquo;s own report of what it applied.
          </Example>
        </Section>

        <Example title="Make a pane wider">
          Drag the border between a list and its contents. Double-click it to reset. The
          navigation collapses to icons from the button at its top.
        </Example>

        <Where>Every section in the left-hand navigation has its own page in this wiki.</Where>
      </Quickstart>

      <Details>
        <Section title="What each part does">
          <Reference
            headers={["Component", "Runs on", "Responsibility"]}
            rows={[
              [
                "Samba AD DC",
                "Domain controllers",
                "The directory, Kerberos, DNS zones and SYSVOL. The authority for every directory object.",
              ],
              [
                "ODM control plane",
                "Domain controller or a dedicated host",
                "The only component that speaks LDAP and Kerberos. Resolves policy, enforces authorisation, writes the audit trail.",
              ],
              [
                "PostgreSQL",
                "With the control plane",
                "Audit log, delegation, recycle bin, policy objects, role registry, certificate inventory. Never the authority for directory objects.",
              ],
              [
                "Console",
                "Any browser",
                "This interface. Talks only to the control plane over HTTPS.",
              ],
              [
                "odm-agent",
                "Every domain member",
                "Pulls its resolved policy, applies it, reports what happened.",
              ],
              [
                "ISC Kea",
                "DHCP role nodes",
                "DHCP service, failover pair, dynamic DNS into the domain zones.",
              ],
            ]}
          />
        </Section>

        <Section title="Sections of the console">
          <Reference
            headers={["Section", "Covers"]}
            rows={[
              ["Overview", "The current session and the domain it belongs to."],
              ["Directory", "Users, groups, computers and organizational units."],
              ["Group Policy", "Policy objects, their settings, links and precedence."],
              ["DNS", "Zones and records in the domain's integrated DNS."],
              ["DHCP", "Scopes, reservations, leases and failover state."],
              ["Certificates", "The domain certificate authority and what it has issued."],
              ["Overview", "Health, replication between controllers, and backups."],
              ["Servers", "Every joined machine and the roles it carries."],
              ["File Shares", "Shared directories and who may reach them."],
              ["Server Roles", "What is installed where, and what can be added."],
              ["Delegation", "Who may do what, and where."],
              ["Deleted Objects", "Restore or purge what has been deleted."],
              ["Audit Log", "Every change, with before and after state."],
            ]}
          />
        </Section>

        <Section title="Order of operations for a new domain">
          <Steps>
            <li>
              <strong>Provision the controller.</strong> <C>deploy/setup.sh</C> on a clean
              Debian 12 or 13 server with a static address.
            </li>
            <li>
              <strong>Create the service account.</strong> The control plane authenticates as this
              account and holds delegated rights to create, read, write and delete child objects
              beneath the domain head.
            </li>
            <li>
              <strong>Set up TLS and the database.</strong> The console is HTTPS only. The
              self-signed certificate can be replaced later with one issued by the domain
              authority.
            </li>
            <li>
              <strong>Create the default policies.</strong> These give every machine a logon
              banner and an agent refresh interval, and give the controllers a baseline.
            </li>
            <li>
              <strong>Build the organizational unit structure</strong> before creating objects, so
              policy links and delegation scopes have somewhere to attach.
            </li>
            <li>
              <strong>Join the first client</strong> and confirm its policy report arrives.
            </li>
            <li>
              <strong>Add roles</strong> — DHCP, file server, certificate authority — as they are
              needed.
            </li>
          </Steps>
          <Note>
            The control plane runs as a local system account named <C>odm</C>, separate from the
            directory account it authenticates as. If a login account of that name already exists,
            pass <C>--service-user &lt;name&gt;</C> to <C>deploy/setup.sh</C> to keep the two
            apart.
          </Note>
        </Section>

        <Section title="Command-line entry points">
          <Reference
            headers={["Command", "Purpose"]}
            rows={[
              [<C key="z">deploy/setup.sh</C>, "Guided setup: everything below, in order."],
              [<C key="a">deploy/provision-dc.sh</C>, "Provision the first domain controller."],
              [
                <C key="b">deploy/create-api-service-account.sh</C>,
                "Create the control plane's service account, SPN and keytab.",
              ],
              [<C key="c">deploy/setup-db.sh</C>, "Create the PostgreSQL role, database and schema."],
              [
                <C key="d">deploy/generate-self-signed.sh</C>,
                "Create the console's first TLS certificate.",
              ],
              [<C key="e">odm-db migrate</C>, "Apply pending database migrations."],
              [<C key="f">odm-client-install</C>, "Join a machine to the domain and install the agent."],
              [<C key="g">odm-agent apply --force</C>, "Apply policy immediately on a client."],
            ]}
          />
        </Section>

        <Section title="Health check after bring-up">
          <Code>{`curl --cacert /etc/odm/tls/api.crt \\
  https://odm.corp.example.internal:8443/api/v1/healthz`}</Code>
          <p>
            Then sign in as a domain administrator, and confirm that an account outside the
            administrators group with nothing delegated is refused. Both outcomes appear in the
            audit log.
          </p>
          <Note>
            The console refuses plaintext HTTP. If a browser cannot reach it, check that the
            certificate and key are readable by the service user and that the host name matches
            the certificate.
          </Note>
        </Section>
      </Details>
    </>
  );
}
