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
  id: "dhcp",
  title: "DHCP",
  section: "Network services",
  summary: "Scopes, pools, options, reservations, leases, failover and dynamic DNS.",
  keywords: [
    "dhcp",
    "kea",
    "scope",
    "subnet",
    "pool",
    "reservation",
    "lease",
    "failover",
    "ha",
    "ddns",
  ],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          DHCP is an installable role. Once installed on two nodes it runs as a failover pair, and
          the addresses it hands out are registered in the domain&rsquo;s DNS automatically.
        </p>

        <Example title="Install the role">
          <strong>Server Roles</strong> → <strong>Certificate authority… DHCP</strong> →{" "}
          <strong>Install</strong>. Install it once as <C>primary</C> and once as <C>standby</C>,
          then add the printed <C>ODM_KEA_*</C> lines to the secrets file and restart the control
          plane.
        </Example>

        <Example title="Create a scope">
          <strong>DHCP</strong> → <strong>New scope</strong> → subnet <C>10.10.0.0/24</C>, pool{" "}
          <C>10.10.0.100 - 10.10.0.200</C>, routers <C>10.10.0.1</C>, DNS servers <C>10.10.0.10</C>.
        </Example>

        <Example title="Reserve an address">
          On the scope row → <strong>Reserve</strong> → hardware address <C>00:11:22:33:44:55</C>,
          address <C>10.10.0.50</C>, host name.
        </Example>

        <Where>DHCP for scopes and leases; Server Roles to install the role.</Where>
      </Quickstart>

      <Details>
        <Section title="Pairing two nodes for failover">
          <p>
            Install the DHCP role on both nodes first — a single node is a working DHCP server on
            its own. Then pair them under <strong>DHCP</strong> → <strong>Configuration</strong>:
            one node primary, the other standby, each with the other&rsquo;s failover address.
            Installing a role and configuring the service it provides are separate steps, so a pair
            can be made, changed or unmade without reinstalling anything.
          </p>
        </Section>

        <Section title="Scopes">
          <Reference
            headers={["Field", "Notes"]}
            rows={[
              ["Subnet", "CIDR. One scope per subnet."],
              ["Pool", "First and last address. Must lie inside the subnet and run forwards."],
              ["Routers", "The default gateway offered to clients."],
              ["DNS servers", "Point clients at the domain controllers so domain names resolve."],
              ["Comment", "Free text shown in the scope list."],
            ]}
          />
          <p>
            Every change is tested against the DHCP service before it is applied, and only then
            written to disk. A change the service would reject leaves the running configuration
            untouched.
          </p>
          <Note>
            Once the role is installed, scopes are managed here only. Editing the service
            configuration by hand is overwritten on the next change made from the console.
          </Note>
        </Section>

        <Section title="What a scope hands out">
          <p>
            Alongside the address, a scope hands out the gateway to use, the servers that resolve
            names, and the domain to append to a bare host name. New scopes are created with the
            domain&rsquo;s own values filled in.
          </p>
          <Reference
            headers={["Option", "Recommended", "What it decides"]}
            rows={[
              [
                <C key="a">routers</C>,
                "The gateway on that subnet",
                "Everything off the local network.",
              ],
              [
                <C key="b">domain-name-servers</C>,
                "Every domain controller, in order",
                <>
                  Which server resolves names. <C key="c">corp.example.internal</C> exists only in
                  the domain&rsquo;s DNS: a client pointed at a public resolver finds no
                  controller, no share, and none of the service records a join reads.
                </>,
              ],
              [
                <C key="e">domain-name</C>,
                "The domain, e.g. corp.example.internal",
                "What a bare host name is completed with, so fs01 reaches fs01.corp.example.internal.",
              ],
            ]}
          />
          <Note>
            A scope with no <C>domain-name-servers</C> is listed as{" "}
            <strong>no DNS server</strong> in the scope list. Clients on it get an address and
            resolve nothing; GNOME Files, asked to open a share, reports &ldquo;Invalid
            argument&rdquo;.
          </Note>
          <Example title="A branch office subnet">
            <Steps>
              <li>
                Subnet <C>172.16.110.0/24</C>, pool <C>172.16.110.100 - 172.16.110.254</C>.
              </li>
              <li>
                Routers <C>172.16.110.1</C> — the branch router, not a controller.
              </li>
              <li>
                DNS servers <C>172.16.110.10, 10.10.0.10</C> — the local controller first, one at
                head office as a fallback.
              </li>
              <li>
                Domain name <C>corp.example.internal</C>.
              </li>
              <li>
                Leave <C>.1</C> to <C>.99</C> outside the pool for switches, printers and anything
                else with a fixed address.
              </li>
            </Steps>
          </Example>
        </Section>

        <Section title="Lease times">
          <p>
            The default lease time suits an office where machines stay put. Shorten it where
            addresses turn over quickly, so a pool is not held by machines that have gone.
          </p>
          <Reference
            headers={["Network", "Recommended lease", "Why"]}
            rows={[
              ["Desks and servers", "8 hours to 1 day", "Machines are the same ones every day."],
              ["Wireless, meeting rooms", "1 to 2 hours", "Visitors come and go; the pool recycles."],
              [
                "Provisioning network",
                "15 to 30 minutes",
                "Machines are installed, joined and moved off it.",
              ],
            ]}
          />
        </Section>

        <Section title="Reservations">
          <p>
            A reservation ties a hardware address to a fixed IP address inside a scope. The address
            must be inside the scope it belongs to, and one hardware address can hold one
            reservation per scope.
          </p>
        </Section>

        <Section title="Leases">
          <p>
            The <strong>Leases</strong> tab lists current leases with their hardware address, host
            name and expiry.
          </p>
        </Section>

        <Section title="A failover pair, worked through">
          <p>
            Two nodes, <C>dhcp1.corp.example.internal</C> at <C>10.10.0.11</C> and{" "}
            <C>dhcp2.corp.example.internal</C> at <C>10.10.0.12</C>, serving the same scopes.
          </p>
          <Steps>
            <li>
              Install the DHCP role on both, from <strong>Server Roles</strong>.
            </li>
            <li>
              <strong>DHCP</strong> → <strong>Configuration</strong> → choose <C>dhcp1</C>, failover
              role <C>primary</C>, this node <C>http://10.10.0.11:8080/</C>, the other node{" "}
              <C>http://10.10.0.12:8080/</C>, then <strong>Apply</strong>.
            </li>
            <li>
              Choose <C>dhcp2</C>, failover role <C>standby</C>, and the same two addresses the
              other way round.
            </li>
            <li>
              Both nodes must be reachable on that port from each other — a firewall between them is
              what leaves the pair in <C>waiting</C> or <C>communications-interrupted</C>.
            </li>
            <li>
              Point relays and helper addresses on the network at both. Clients on the same wire as
              the servers find them by broadcast.
            </li>
          </Steps>
          <Note>
            Scopes are configured on each node. A pair whose scopes differ hands out different
            answers depending on which node replied.
          </Note>
        </Section>

        <Section title="Failover states">
          <p>
            The two nodes run as a hot-standby pair. The header shows this node&rsquo;s state and
            its role, and whether the peer is reachable.
          </p>
          <Reference
            headers={["State", "Meaning"]}
            rows={[
              ["hot-standby", "Normal operation; the primary is serving."],
              ["partner-down", "The peer is unreachable and this node is serving alone."],
              ["waiting, syncing", "Starting up and catching up with the peer."],
              ["ready", "Synchronised and about to serve."],
            ]}
          />
        </Section>

        <Section title="Dynamic DNS">
          <p>
            The DHCP service updates the domain&rsquo;s forward and reverse zones as it issues
            leases, so a host that receives an address resolves without anyone touching DNS. The
            update is authenticated with GSS-TSIG using a keytab exported for the purpose.
          </p>
          <Steps>
            <li>
              On a domain controller, create the service account and export its keytab to{" "}
              <C>/etc/odm/kea-ddns.keytab</C>.
            </li>
            <li>Re-run the role installer so it configures the authenticated update path.</li>
          </Steps>
          <Note>
            Debian does not package the GSS-TSIG hook, so on a stock install this path is
            unavailable and the role installer says so. Samba&rsquo;s zones reject unauthenticated
            updates, so leases do not appear in DNS until the hook is built from ISC&rsquo;s sources
            and the installer re-run, or hosts are registered another way — a domain-joined machine
            registers itself.
          </Note>
        </Section>

        <Section title="Utilisation">
          <p>
            The scope list shows assigned addresses against the pool total. The same figures appear
            on the health dashboard under Overview.
          </p>
        </Section>
      </Details>
    </>
  );
}
