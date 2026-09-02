import {
  C,
  Code,
  Details,
  Example,
  Note,
  PageLink,
  Quickstart,
  Reference,
  Section,
  Steps,
  Where,
} from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "client-enrolment",
  title: "Client enrolment",
  section: "Clients",
  summary:
    "Zero-touch deployment: network boot, an unattended Debian install, and a domain join on first boot.",
  keywords: [
    "pxe",
    "network boot",
    "tftp",
    "preseed",
    "unattended",
    "deployment",
    "netboot",
    "enrolment",
    "provisioning",
    "image",
  ],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          A machine boots from the network, installs Debian unattended, and joins the domain on
          first boot. Which release, from which mirror, into which container is set on the{" "}
          <strong>Client Enrolment</strong> page and applied by re-running the boot server&rsquo;s
          installer.
        </p>

        <Example title="Set it up, end to end">
          <Steps>
            <li>
              <strong>Directory</strong> → <strong>Enrolment tokens</strong> → create a multi-use
              token. Installed machines join with it.
            </li>
            <li>
              <strong>Server Roles</strong> → <strong>DHCP</strong> → install it, if nothing already
              serves addresses on the network machines will boot on.
            </li>
            <li>
              <strong>Server Roles</strong> → <strong>Client enrolment (PXE)</strong> →{" "}
              <strong>Install</strong> on the server that will hold the boot images.
            </li>
            <li>
              <strong>Client Enrolment</strong> → set the release, the token and the container, tick
              the network to offer boot on, then <strong>Apply</strong>.
            </li>
            <li>
              Boot a machine from the network. It installs, restarts, joins, and appears under
              Directory with the policy for its container already applied.
            </li>
          </Steps>
        </Example>

        <Example title="Build every machine the same, months apart">
          Set <strong>Mirror</strong> to a snapshot —{" "}
          <C>https://snapshot.debian.org/archive/debian/20250801T000000Z</C>. The default mirror
          tracks the release, so machines built weeks apart carry different package versions.
        </Example>

        <Where>
          Client Enrolment, once the enrolment role and DHCP are both installed. Roles are installed
          under Server Roles.
        </Where>
      </Quickstart>

      <Details>
        <Section title="What each setting decides">
          <Reference
            headers={["Setting", "Recommended", "What it decides"]}
            rows={[
              [
                "Network interface",
                "Leave unset",
                "The interface installs are served on. Unset uses the interface holding the default route, which is right on a single-homed server.",
              ],
              [
                "Domain to join",
                "The domain, e.g. corp.example.internal",
                "What an installed machine joins. Optional; the control plane's own domain is used when it is empty.",
              ],
              [
                "Enrolment token",
                "A multi-use token created for deployment",
                "What the machine authenticates its join with. One is issued when the field is empty; a token created under Directory can be revoked on its own.",
              ],
              [
                "Debian release",
                "The release you support",
                "Which netboot image is fetched and which release is installed. Changing it fetches the other image on the next Apply.",
              ],
              [
                "Mirror",
                "A snapshot URL for fleets, the default for a lab",
                "Where packages come from. A snapshot pins a point release; the default moves as the release does.",
              ],
              [
                "Container for installed machines",
                "An OU you link policy to, e.g. OU=Workstations,DC=corp,DC=example,DC=internal",
                "Where the computer account is created. Set it to the OU carrying the policy for these machines; empty means the default Computers container.",
              ],
              [
                "Local administrator account",
                "localadmin",
                "Created on every installed machine, for when the domain cannot be reached.",
              ],
              [
                "Local administrator password hash",
                "Generated",
                <>
                  A <C key="a">crypt(3)</C> hash, as <C key="b">openssl passwd -6</C> produces. One
                  is generated and printed once when the field is empty.
                </>,
              ],
              [
                "Client installer",
                <C key="c">/usr/sbin/odm-client-install</C>,
                "The join binary published to installs. The role installer requires it.",
              ],
            ]}
          />
        </Section>

        <Section title="Networks to offer boot on">
          <p>
            Network boot is advertised over DHCP, so a deployment reaches the scopes ticked and no
            others. A machine on a desk port is not offered an installer; one on the provisioning
            VLAN is.
          </p>
          <Note>
            The boot server runs as a proxy DHCP server: it answers boot questions only, and
            addresses still come from the DHCP role or whatever already serves that network.
          </Note>
        </Section>

        <Section title="A provisioning network, worked through">
          <p>
            A separate VLAN for building machines, with the boot server on it at{" "}
            <C>172.16.110.10</C>.
          </p>
          <Steps>
            <li>
              <strong>DHCP</strong> → <strong>New scope</strong> → subnet{" "}
              <C>172.16.110.0/24</C>, pool <C>172.16.110.100 - 172.16.110.254</C>, routers{" "}
              <C>172.16.110.1</C>, DNS servers the domain controllers, domain name the domain.
            </li>
            <li>
              Install the enrolment role on the machine at <C>172.16.110.10</C>, so the boot server
              is on the same wire as the machines it serves.
            </li>
            <li>
              <strong>Client Enrolment</strong> → tick <C>172.16.110.0/24</C> under{" "}
              <strong>Networks to offer boot on</strong>, and leave every other scope unticked.
            </li>
            <li>
              Set the container to the OU new machines belong in, and apply.
            </li>
            <li>
              Move a built machine to its desk VLAN afterwards. It is joined by then and finds the
              domain through DNS.
            </li>
          </Steps>
          <Note>
            Where the boot server is not on the same wire as the machines, the router has to relay
            the boot request to it — <C>ip helper-address</C> pointing at both the address server
            and the boot server.
          </Note>
        </Section>

        <Section title="What happens on the machine">
          <Steps>
            <li>It boots from the network, on one of the scopes chosen above.</li>
            <li>
              The boot server offers Debian&rsquo;s installer and points it at a preseed, so nothing
              is answered by hand.
            </li>
            <li>
              The installer partitions the disk, installs the release chosen, and creates the local
              administrator account.
            </li>
            <li>
              On first boot it fetches <C>odm-client-install</C> from the boot server and joins the
              domain with the enrolment token, into the container set above.
            </li>
            <li>
              The agent is installed and enabled by the join, so the machine applies policy from its
              first check-in.
            </li>
          </Steps>
        </Section>

        <Section title="Where it lives on the boot server">
          <Reference
            headers={["Path", "Holds"]}
            rows={[
              [<C key="1">/srv/tftp</C>, "The Debian netboot images for the chosen release."],
              [<C key="2">/srv/odm-preseed/odm.cfg</C>, "The unattended installation answers."],
              [
                <C key="3">/srv/odm-preseed/odm-client-install</C>,
                "The join binary, published by the installer.",
              ],
            ]}
          />
          <p>
            All three are rewritten by <strong>Apply</strong>; edits made on the server are
            replaced by the next change from the console.
          </p>
        </Section>

        <Section title="When a machine will not build">
          <Reference
            headers={["Symptom", "Usually", "What to check"]}
            rows={[
              [
                "The machine gets an address, then times out looking for a boot file",
                "The scope it is on is not ticked, or the boot server is on another wire.",
                "Client Enrolment → Networks to offer boot on; then the relay on the router.",
              ],
              [
                "It boots the installer, which then cannot fetch packages",
                "The mirror is unreachable from the provisioning network.",
                <>
                  From the boot server: <C key="a">curl -I &lt;mirror&gt;/dists/stable/Release</C>.
                </>,
              ],
              [
                "It installs and never appears in Directory",
                "The join failed — usually a spent or revoked token, or DNS.",
                <>
                  Sign in as the local administrator and read{" "}
                  <C key="b">journalctl -u odm-client-install</C>.
                </>,
              ],
              [
                "Client Enrolment is not in the sidebar",
                "One of the two roles is missing.",
                "Server Roles: the enrolment role and DHCP both have to be installed.",
              ],
            ]}
          />
          <Code>{`# on the boot server, to see whether it answered at all
sudo journalctl -u dnsmasq -n 50
ls -l /srv/tftp /srv/odm-preseed`}</Code>
        </Section>

        <Section title="Joining a machine that already exists">
          <p>
            Enrolment builds new machines. An installed machine joins with the client installer
            instead, by hand or from a script — see{" "}
            <PageLink page="domain-join">Domain join</PageLink>. Both end with a computer account, a
            keytab and the agent enabled.
          </p>
        </Section>
      </Details>
    </>
  );
}
