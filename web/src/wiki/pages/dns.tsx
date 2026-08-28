import { C, Details, Example, Note, Quickstart, Reference, Section, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "dns",
  title: "DNS",
  section: "Network services",
  summary: "Zones and records in the domain's integrated DNS, and dynamic update status.",
  keywords: ["dns", "zone", "record", "a", "cname", "srv", "ptr", "reverse", "dynamic update"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          The domain&rsquo;s DNS is served by the domain controllers and stored in the directory,
          so it replicates with everything else. The zone that matches the domain name is created
          during provisioning and already holds the service records clients use to find the
          domain.
        </p>

        <Example title="Add a host record">
          <strong>DNS</strong> → select the zone → <strong>New record</strong> → name{" "}
          <C>fs01</C>, type <C>A</C>, data <C>10.10.0.20</C>.
        </Example>
        <Example title="Add a reverse zone">
          <strong>New zone</strong> → <C>10.in-addr.arpa</C>. Then add{" "}
          <C>PTR</C> records inside it.
        </Example>
        <Example title="Add an alias">
          <strong>New record</strong> → name <C>files</C>, type <C>CNAME</C>, data{" "}
          <C>fs01.corp.example.internal.</C> — note the trailing dot.
        </Example>

        <Where>DNS. Zones are listed on the left; the records of the selected zone on the right.</Where>
      </Quickstart>

      <Details>
        <Section title="Record types">
          <Reference
            headers={["Type", "Data format", "Example"]}
            rows={[
              ["A", "An IPv4 address", <C key="a">10.10.0.20</C>],
              ["AAAA", "An IPv6 address", <C key="b">2001:db8::20</C>],
              ["CNAME", "A host name, usually fully qualified with a trailing dot", <C key="c">fs01.corp.example.internal.</C>],
              ["PTR", "A host name, in a reverse zone", <C key="d">fs01.corp.example.internal.</C>],
              ["NS", "A name server host name", <C key="e">dc1.corp.example.internal.</C>],
              ["MX", "Preference then host name", <C key="f">10 mail.corp.example.internal</C>],
              ["SRV", "Priority, weight, port, target", <C key="g">0 100 389 dc1.corp.example.internal</C>],
              ["TXT", "Free text", <C key="h">v=spf1 -all</C>],
            ]}
          />
          <Note>
            Record data is validated for its type before it is written: an A record must parse as
            an IPv4 address, an SRV record must have all four fields, and so on.
          </Note>
        </Section>

        <Section title="Record names">
          <Reference
            headers={["Name", "Means"]}
            rows={[
              [<C key="1">@</C>, "The zone itself."],
              [<C key="2">fs01</C>, "A name relative to the zone."],
              [<C key="3">_ldap._tcp</C>, "A service record name."],
              [<C key="4">*</C>, "A wildcard."],
            ]}
          />
        </Section>

        <Section title="Zones">
          <p>
            The zone matching the domain name is created during provisioning. Additional forward
            zones and reverse zones can be created and deleted here. Deleting a zone removes every
            record in it; the records are captured in the audit entry.
          </p>
          <Note>
            The zone the domain depends on holds the service records clients use to locate domain
            controllers. Deleting it stops sign-in and domain join working.
          </Note>
        </Section>

        <Section title="Dynamic updates">
          <p>
            Zones created by provisioning accept secure dynamic updates, so domain members register
            themselves and the DHCP service can register the computers it gives addresses to. The zone
            list marks which zones have this enabled.
          </p>
        </Section>

        <Section title="Availability">
          <p>
            DNS management is available where the control plane runs on a domain controller. On any
            other host, the DNS section says so rather than failing.
          </p>
        </Section>
      </Details>
    </>
  );
}
