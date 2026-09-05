import {
  C,
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
  id: "server-roles",
  title: "Server roles",
  section: "Administration",
  summary:
    "What is installed where, and how to add DHCP, file, print, remote desktop and certificate roles.",
  keywords: ["role", "install", "dhcp", "file server", "ca", "extend", "plugin", "node"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          A fresh install runs the core role: the directory, Group Policy and DNS. Everything else
          is added afterwards without redeploying anything.
        </p>

        <Example title="Add a role">
          <Steps>
            <li>
              <strong>Server Roles</strong> → click the role → <strong>Install on a server</strong>.
            </li>
            <li>
              <strong>Select…</strong> and choose the server. Any joined machine can carry a role,
              not only a controller.
            </li>
            <li>
              Fill in what installing needs. How the service then behaves — pairing two DHCP nodes
              for failover, for instance — is set afterwards under that service&rsquo;s own section.
            </li>
            <li>
              The role&rsquo;s row lists every server it runs on and the state of each. It moves
              from <C>installing</C> to <C>active</C>.
            </li>
            <li>
              Add any settings the installer prints to the secrets file, then restart the control
              plane.
            </li>
          </Steps>
        </Example>

        <Where>Server Roles.</Where>
      </Quickstart>

      <Details>
        <Section title="Roles">
          <Reference
            headers={["Role", "Provides", "Needs"]}
            rows={[
              [
                "Core",
                "The directory, Kerberos, SYSVOL and the integrated DNS zones. Always present.",
                "—",
              ],
              [
                "DHCP",
                "A failover pair with dynamic DNS into the domain's own zones.",
                "Failover role, this node's and the peer's URLs, the realm, a DNS server.",
              ],
              [
                "File server",
                "Kerberos-authenticated SMB shares for drive maps.",
                "Share name, share path, optionally a group allowed to use it.",
              ],
              [
                "Time",
                "chrony, serving the domain. Kerberos gives up on a clock more than five minutes out, so every sign-in depends on it.",
                "Optionally an upstream source and the networks that may ask.",
              ],
              [
                "Print server",
                "CUPS printers, published to the domain and handed out by policy.",
                "Nothing. The printers are added under Printers.",
              ],
              [
                "Remote desktop session host",
                "Serves desktops and published applications over RDP.",
                "Nothing. Everything is decided by the collection it joins.",
              ],
              [
                "Remote desktop broker",
                "The address people connect to; sends each back to the host they were last on.",
                "Nothing. Collections are made under Remote Desktop.",
              ],
              [
                "Remote access (VPN)",
                "WireGuard tunnels for machines and people outside the network.",
                "Optionally the interface facing the internet.",
              ],
              [
                "Certificate authority",
                "An internal CA that issues certificates and publishes its root through policy.",
                "Optionally a CA directory.",
              ],
              [
                "Client enrolment (PXE)",
                "Unattended Debian installation over the network, joining the domain on first boot.",
                "Interface and domain to install. Everything else is set under Client Enrolment.",
              ],
            ]}
          />
        </Section>

        <Section title="Installation states">
          <Reference
            headers={["State", "Means"]}
            rows={[
              ["installing", "The installer is running. The list refreshes while it does."],
              ["active", "The installer finished successfully."],
              ["failed", "The installer failed. The reason is shown on the row."],
              ["removed", "Deregistered from ODM. The packages are still running on the node."],
            ]}
          />
          <Note>
            Installing a role means package installation and service restarts, so it takes minutes.
            A machine that stops reporting mid-install does not leave the role saying{" "}
            <strong>installing</strong> for ever: after 45 minutes it is marked failed, with the
            reason on the row, and can be installed again.
          </Note>
          <p>
            Open the role while it installs and the row says whether the machine has picked the
            work up and for how long it has had it, with the installer&rsquo;s own output
            underneath, updated every few seconds. There is no percentage because apt does not
            report one; the machine&rsquo;s actual words are the honest answer to whether anything
            is happening. The same output is kept as the failure reason if it ends badly.
          </p>
          <p>
            A machine runs one task at a time. A second role queued behind a long install says{" "}
            <strong>installing</strong> and &ldquo;waiting for the machine to collect it&rdquo;
            until the first finishes.
          </p>
          <p>
            A role that fails on a machine can leave that machine&rsquo;s package manager
            half-configured, and from then on every later install fails complaining about
            dependencies the archive plainly has. The installers repair that state before they
            begin, and a service that then refuses to start reports its own journal rather than
            just its name.
          </p>
        </Section>

        <Section title="Client enrolment (PXE)">
          <p>
            The role serves network boot as a proxy DHCP server, so address assignment stays with
            the DHCP role or whatever already provides it. A machine that boots from the network
            installs Debian unattended, then joins the domain on first boot.
          </p>
          <p>
            What it installs is configuration, not part of installing the role:{" "}
            <strong>Client Enrolment</strong> sets the release, the mirror, the domain and container
            joined machines land in, the enrolment token and the local administrator account.
            Changing any of it rewrites the preseed and fetches the right netboot image; nothing is
            reinstalled.
          </p>
          <Reference
            headers={["Path", "Holds"]}
            rows={[
              [<C key="1">/srv/tftp</C>, "The Debian netboot images."],
              [<C key="2">/srv/odm-preseed/odm.cfg</C>, "The unattended installation answers."],
              [
                <C key="3">/srv/odm-preseed/odm-client-install</C>,
                "The join binary, published by the installer.",
              ],
            ]}
          />
          <Reference
            headers={["Setting", "Effect"]}
            rows={[
              [
                "Networks to offer boot on",
                "The DHCP scopes boot is advertised in. Machines on any other network are not offered it at all, so a provisioning network stays separate from a client network.",
              ],
              ["Debian release", "Which netboot image is fetched and which release is installed."],
              [
                "Mirror",
                "A snapshot.debian.org URL installs a fixed point release; the default installs whatever the release currently is.",
              ],
              ["Container", "Where the computer account is created when the machine joins."],
              [
                "Local administrator",
                "An account created on every installed machine. A password is generated and printed once if none is given.",
              ],
            ]}
          />
          <Note>
            Client Enrolment appears only once both this role and DHCP are installed: boot is
            advertised over DHCP, so without a DHCP server there is nothing to attach a deployment
            to. Create a multi-use enrolment token under <strong>Directory</strong> first. The join
            binary is published by the installer, which refuses to run without it rather than
            leaving machines that install and never join.
          </Note>
        </Section>

        <Section title="Time">
          <p>
            The one role whose absence is felt everywhere else. Kerberos refuses a ticket whose
            timestamp is more than five minutes out, so a machine with a drifting clock stops
            being able to sign in, mount a share or apply policy &mdash; and says none of that in
            a way anybody reads as a clock problem.
          </p>
          <p>
            Installing it on the domain controllers is usually all there is to do: a domain-joined
            machine already asks its controller for the time. Left empty, the upstream is
            Debian&rsquo;s own pool and the networks allowed to ask are the ones the machine is
            on.
          </p>
          <Reference
            headers={["Command", "Answers"]}
            rows={[
              [<C key="a">chronyc sources</C>, "Where this machine gets the time, and how far out it is"],
              [<C key="b">chronyc clients</C>, "Who is asking it for the time"],
            ]}
          />
          <Note>
            Uninstalling the role removes ODM&rsquo;s configuration and leaves chrony running on
            its own. A machine with no time source is a machine that stops being able to sign in,
            which is not what uninstalling ODM should do.
          </Note>
        </Section>

        <Section title="Deregistering">
          <p>
            Deregistering removes ODM&rsquo;s record of the role. It does not uninstall packages or
            stop services on the node; do that on the node itself.
          </p>
        </Section>

        <Section title="What actually installs it">
          <p>
            The agent on the target machine, always &mdash; including when the target is the
            controller the console runs on. The control plane runs sandboxed and unprivileged, so it
            cannot install a package even on its own host, and a second privileged path just for the
            local case would be a second thing to get wrong.
          </p>
          <Reference
            headers={["File", "Purpose"]}
            rows={[
              [
                <C key="1">/usr/lib/odm/roles/install-*-role.sh</C>,
                "The installers, shipped with the agent.",
              ],
              [<C key="2">odm-agent</C>, "Runs them as root when the console asks."],
            ]}
          />
          <Note>
            A server with no agent can be seen in the console but nothing can be installed on it.{" "}
            <C>setup.sh</C> installs the agent on the first controller as its last step.
          </Note>
        </Section>

        <Section title="Adding a new role">
          <p>A role is three things.</p>
          <Steps>
            <li>
              A descriptor in the control plane naming the role, its arguments, the packages it
              installs and any settings it produces.
            </li>
            <li>
              An installer script under <C>deploy/</C>, and a case for it in the privileged helper.
            </li>
            <li>A console section that appears once the role reports active.</li>
          </Steps>
          <Note>
            Only arguments a descriptor declares are ever passed to an installer, and each is
            pattern-checked first.
          </Note>
        </Section>
      </Details>
    </>
  );
}
