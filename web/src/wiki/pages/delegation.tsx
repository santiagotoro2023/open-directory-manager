import { C, Details, Example, Note, Quickstart, Reference, Section, Steps, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "delegation",
  title: "Delegation",
  section: "Administration",
  summary: "Roles, permissions and scoped assignments: who may do what, and where.",
  keywords: ["rbac", "delegate", "permission", "role", "scope", "helpdesk", "auditor", "least privilege"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          Members of the domain administrators group can do everything. Anyone else gets access
          through an assignment: a role, holding a set of permissions, granted at an organizational
          unit. The assignment applies to that unit and everything beneath it.
        </p>

        <Example title="Let a helpdesk team manage one department">
          <Steps>
            <li>
              <strong>Delegation</strong> → <strong>New assignment</strong>.
            </li>
            <li>
              Role <C>helpdesk</C>.
            </li>
            <li>Search for the group that holds the helpdesk staff.</li>
            <li>
              Scope <C>OU=Sales,DC=corp,DC=example,DC=internal</C>.
            </li>
            <li>
              <strong>Assign</strong>.
            </li>
          </Steps>
          They can now sign in and manage users and hosts under Sales, and nothing else.
        </Example>

        <Example title="Give someone read-only visibility">
          Assign the <C>auditor</C> role at the domain head.
        </Example>

        <Example title="Build a role of your own">
          <strong>Roles</strong> tab → <strong>New role</strong> → name it, tick the permissions it
          should hold.
        </Example>

        <Where>Delegation. Only domain administrators see this section.</Where>
      </Quickstart>

      <Details>
        <Section title="How access is decided">
          <Steps>
            <li>
              A member of the domain administrators group holds every permission everywhere.
            </li>
            <li>
              Anyone else holds exactly the permissions their assignments grant, at exactly the
              scopes they are granted.
            </li>
            <li>
              An account with neither cannot sign in, and the refusal is recorded in the audit log.
            </li>
          </Steps>
          <p>
            Membership is re-checked against the directory periodically. An account that loses both
            its administrators-group membership and every assignment has its session revoked at its
            next request.
          </p>
        </Section>

        <Section title="Scopes">
          <p>
            A scope is a distinguished name. It covers that object and everything beneath it, and
            nothing else.
          </p>
          <Reference
            headers={["Assignment scope", "Covers", "Does not cover"]}
            rows={[
              [
                <C key="1">OU=Sales,DC=corp,…</C>,
                <>
                  <C>OU=Sales</C> itself, <C>CN=ada,OU=Sales</C>, <C>OU=West,OU=Sales</C>
                </>,
                <>
                  <C>DC=corp,…</C>, <C>OU=Finance,…</C>, <C>OU=Sales2,…</C>
                </>,
              ],
              [
                <C key="2">DC=corp,DC=example,DC=internal</C>,
                "Everything in the domain",
                "Nothing",
              ],
            ]}
          />
          <Note>
            Actions that are not about a single object — managing DNS, DHCP, policy objects or
            backups — need the permission at the domain head.
          </Note>
        </Section>

        <Section title="Built-in roles">
          <Reference
            headers={["Role", "Holds"]}
            rows={[
              ["domain-admin", "Everything."],
              [
                "helpdesk",
                "Read the directory; create and edit users and hosts; reset passwords; edit group membership; move objects; read the recycle bin and the audit log.",
              ],
              [
                "auditor",
                "Read-only across the directory, policy, DNS, DHCP, roles, replication, backups and the audit log.",
              ],
              ["dns-admin", "Read the directory; read and write DNS."],
              ["dhcp-admin", "Read the directory; read and write DHCP."],
              ["policy-admin", "Read the directory; read and write policy objects and administrative templates."],
            ]}
          />
          <p>Built-in roles cannot be edited or deleted. Create a custom role instead.</p>
        </Section>

        <Section title="Permissions">
          <Reference
            headers={["Permission", "Allows"]}
            rows={[
              ["directory.read", "Browsing and searching directory objects."],
              ["user.write", "Creating and editing users."],
              ["user.password.reset", "Resetting a user's password."],
              ["group.write", "Creating and editing groups."],
              ["group.member.write", "Changing group membership."],
              ["computer.write", "Creating and editing hosts."],
              ["ou.write", "Creating and editing organizational units."],
              ["object.move", "Moving an object. Required at both source and destination."],
              ["object.delete", "Deleting an object."],
              ["gpo.read / gpo.write", "Viewing and changing policy objects and links."],
              ["admx.write", "Importing and removing administrative templates."],
              ["dns.read / dns.write", "Viewing and changing DNS."],
              ["dhcp.read / dhcp.write", "Viewing and changing DHCP."],
              ["ca.read / ca.issue", "Viewing the authority; issuing and revoking certificates."],
              ["recyclebin.read / restore / purge", "Viewing, restoring and permanently purging deleted objects."],
              ["role.read / role.install", "Viewing and installing server roles."],
              ["replication.read / replication.replicate", "Viewing replication state; forcing a run."],
              ["backup.read / backup.write", "Viewing backups; taking one."],
              ["health.read", "The health dashboard."],
              ["audit.read", "The audit log."],
              ["rbac.write", "Managing delegation."],
            ]}
          />
          <Note>
            Some actions are reserved for domain administrators regardless of permissions:
            managing delegation, installing and deregistering roles, creating the certificate
            authority, publishing its root and replacing the console certificate.
          </Note>
        </Section>

        <Section title="What a delegate sees">
          <p>
            The console hides sections the operator holds no permission for, and marks the session
            as delegated in the header. Attempting an action outside the delegation is refused with
            the permission that was missing and the object it was missing on.
          </p>
        </Section>

        <Section title="Assignments and groups">
          <p>
            An assignment can name a user or a group. Naming a group is generally preferable:
            membership changes take effect without touching the assignment, and nesting is
            followed.
          </p>
        </Section>
      </Details>
    </>
  );
}
