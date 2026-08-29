import { C, Details, Example, Note, Quickstart, Reference, Section, Steps, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "operations",
  title: "Health and backups",
  section: "Administration",
  summary: "Health, replication between domain controllers, and domain backups.",
  keywords: ["health", "replication", "drs", "backup", "restore", "monitoring", "dashboard"],
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
          <strong>Overview</strong> → <strong>Health</strong>. Each card reports one subsystem
          and says so plainly when that subsystem is not installed.
        </Example>
        <Example title="Force replication">
          <strong>Replication</strong> → the row for a partnership → <strong>Replicate now</strong>.
        </Example>
        <Example title="Take a backup">
          <strong>Backups</strong> → <strong>Back up now</strong>. It runs in the background and
          appears in the list when it finishes.
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
              ["Agents", "How many machines have reported, and how many did so recently. Also how many settings are currently failing."],
              ["DHCP", "Address utilisation per scope, when the role is installed."],
              ["Certificates", "The authority's expiry, and certificates expiring within 30 days."],
              ["Backups", "When the last backup completed and how large it was."],
            ]}
          />
          <p>
            A machine counts as stale when its last report is older than three refresh intervals.
          </p>
        </Section>

        <Section title="Replication">
          <p>
            Every domain controller is listed from its own account. For the controller the control
            plane talks to, each inbound partnership is shown with its naming context, its partner,
            the last attempt, and the consecutive failure count.
          </p>
          <Reference
            headers={["Naming context", "Holds"]}
            rows={[
              [<C key="1">DC=corp,DC=example,DC=internal</C>, "The domain: users, groups, computers, organizational units."],
              [<C key="2">CN=Configuration,…</C>, "Forest configuration: sites, services, partitions."],
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

        <Section title="Backups">
          <p>
            A backup produces one archive holding the directory, SYSVOL and the domain
            configuration. Backups run on a schedule and can be taken on demand.
          </p>
          <Reference
            headers={["Setting", "Meaning"]}
            rows={[
              [<C key="1">ODM_BACKUP_DIR</C>, "Where archives are written. Unset, backups are unavailable."],
              [<C key="2">ODM_BACKUP_INTERVAL_HOURS</C>, "Scheduled interval. 24 by default."],
              [<C key="3">ODM_BACKUP_KEEP</C>, "How many archives to keep. 14 by default."],
            ]}
          />
          <p>
            Retention keeps the newest archives and removes the rest. Nothing in the directory that
            is not a backup archive is touched.
          </p>
        </Section>

        <Section title="Restore drill">
          <p>
            Restoring a domain is a deliberate operation performed on the controller, not from a
            web interface. The archives are the input to the standard Samba restore.
          </p>
          <Steps>
            <li>Stop the domain controller service on the target machine.</li>
            <li>Move the existing directory state aside rather than deleting it.</li>
            <li>
              Restore the archive with <C>samba-tool domain backup restore</C>, giving the target
              directory and the new server name.
            </li>
            <li>
              Put the restored Kerberos configuration in place and start the service.
            </li>
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
