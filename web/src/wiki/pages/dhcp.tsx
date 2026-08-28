import { C, Details, Example, Note, Quickstart, Reference, Section, Steps, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "dhcp",
  title: "DHCP",
  section: "Network services",
  summary: "Scopes, pools, options, reservations, leases, failover and dynamic DNS.",
  keywords: ["dhcp", "kea", "scope", "subnet", "pool", "reservation", "lease", "failover", "ha", "ddns"],
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
          <strong>Install</strong>. Install it once as <C>primary</C> and once as{" "}
          <C>standby</C>, then add the printed <C>ODM_KEA_*</C> lines to the secrets file and
          restart the control plane.
        </Example>

        <Example title="Create a scope">
          <strong>DHCP</strong> → <strong>New scope</strong> → subnet{" "}
          <C>10.10.0.0/24</C>, pool <C>10.10.0.100 - 10.10.0.200</C>, routers{" "}
          <C>10.10.0.1</C>, DNS servers <C>10.10.0.10</C>.
        </Example>

        <Example title="Reserve an address">
          On the scope row → <strong>Reserve</strong> → hardware address{" "}
          <C>00:11:22:33:44:55</C>, address <C>10.10.0.50</C>, host name.
        </Example>

        <Where>DHCP for scopes and leases; Server Roles to install the role.</Where>
      </Quickstart>

      <Details>
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

        <Section title="Failover">
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
            updates, so leases do not appear in DNS until the hook is built from ISC&rsquo;s
            sources and the installer re-run, or hosts are registered another way — a domain-joined
            machine registers itself.
          </Note>
        </Section>

        <Section title="Utilisation">
          <p>
            The scope list shows assigned addresses against the pool total. The same figures appear
            on the health dashboard under Operations.
          </p>
        </Section>
      </Details>
    </>
  );
}
