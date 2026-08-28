import { C, Details, Quickstart, Reference, Section, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "architecture",
  title: "Architecture",
  section: "Reference",
  summary: "The components, where data lives, and how a request travels through the system.",
  keywords: ["architecture", "components", "design", "ports", "data", "postgres", "samba"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          Four things run: a Samba domain controller, the ODM control plane with its PostgreSQL
          database, this console, and an agent on every domain member. Optional roles add ISC Kea
          for DHCP, a Samba file server, and a certificate authority.
        </p>
        <Reference
          headers={["Component", "Speaks to", "Over"]}
          rows={[
            ["Console", "Control plane", "HTTPS"],
            ["Control plane", "Domain controller", "LDAPS and Kerberos"],
            ["Control plane", "PostgreSQL", "Local socket or TCP"],
            ["Control plane", "Kea control agent", "HTTP on the loopback, or HTTPS"],
            ["Agent", "Control plane", "HTTPS with SPNEGO"],
            ["Agent", "File server", "SMB with Kerberos"],
          ]}
        />
        <Where>Operations → Health reports the state of each of these.</Where>
      </Quickstart>

      <Details>
        <Section title="Where data lives">
          <Reference
            headers={["Data", "Stored in"]}
            rows={[
              ["Users, groups, hosts, organizational units", "The directory on the domain controllers"],
              ["DNS zones and records", "The directory, replicated with everything else"],
              ["Kerberos principals and keys", "The directory"],
              ["Policy objects, settings and links", "PostgreSQL, mirrored into the directory and SYSVOL when configured"],
              ["Administrative template definitions", "PostgreSQL"],
              ["Audit log", "PostgreSQL, append-only"],
              ["Delegation roles and assignments", "PostgreSQL"],
              ["Deleted-object snapshots", "PostgreSQL"],
              ["Certificate inventory", "PostgreSQL; the CA key on disk in the CA directory"],
              ["Agent reports", "PostgreSQL"],
              ["DHCP scopes and leases", "The DHCP service's own configuration and lease file"],
            ]}
          />
          <p>PostgreSQL is never the authority for a directory object.</p>
        </Section>

        <Section title="A request from the console">
          <Reference
            headers={["Stage", "What happens"]}
            rows={[
              ["Transport", "HTTPS only. Hardening headers on every response."],
              ["Origin", "State-changing requests from an unlisted origin are refused."],
              ["Session", "The cookie carries a random token; the database holds only its hash."],
              ["CSRF", "State-changing requests must carry the session's token in a header."],
              ["Authorisation", "The route's permission is checked, scoped to the object named."],
              ["Directory", "The control plane binds with its own service credential and acts."],
              ["Audit", "The change is written with actor, outcome and before-and-after state."],
            ]}
          />
        </Section>

        <Section title="A request from an agent">
          <Reference
            headers={["Stage", "What happens"]}
            rows={[
              ["Authentication", "SPNEGO with the machine keytab. No cookie, no CSRF token."],
              ["Identity", "The Kerberos principal names the host account whose policy is served."],
              ["Resolution", "Precedence, inheritance, filtering and targeting are resolved server-side."],
              ["Response", "One flattened settings document with a fingerprint."],
              ["Report", "The agent posts back per-setting results."],
            ]}
          />
        </Section>

        <Section title="Ports">
          <Reference
            headers={["Port", "Service"]}
            rows={[
              ["8443/tcp", "The console and API"],
              ["636/tcp", "LDAPS to the domain controllers"],
              ["88/tcp, 88/udp", "Kerberos"],
              ["53/tcp, 53/udp", "DNS"],
              ["445/tcp", "SMB, for SYSVOL and file shares"],
              ["67/udp", "DHCP"],
              ["8080/tcp", "DHCP failover between the pair"],
              ["8000/tcp", "The Kea control agent, on the loopback"],
              ["5432/tcp", "PostgreSQL"],
            ]}
          />
        </Section>

        <Section title="Service accounts">
          <Reference
            headers={["Account", "Used by", "Holds"]}
            rows={[
              [
                <C key="1">svc-odm-api</C>,
                "The control plane",
                "Create, read, write and delete child objects beneath the domain head. Not a domain administrator.",
              ],
              [
                "Each host account",
                "That machine's agent",
                "Reads its own policy and posts its own report.",
              ],
              [
                <C key="2">svc-kea-ddns</C>,
                "The DHCP dynamic-update service",
                "Writes the records for the leases it issues.",
              ],
              [
                <C key="3">odm</C>,
                "The control-plane process",
                "An unprivileged local account. Two commands through sudo: installing a role, and installing a console certificate.",
              ],
            ]}
          />
        </Section>

        <Section title="Configuration">
          <p>
            All configuration and every secret come from one file, referenced by{" "}
            <C>ODM_SECRETS_FILE</C> and normally <C>/etc/odm/odm.env</C>. It must not be
            group-writable or world-accessible. Values already present in the environment take
            precedence, so a secrets manager can inject them instead.
          </p>
        </Section>
      </Details>
    </>
  );
}
