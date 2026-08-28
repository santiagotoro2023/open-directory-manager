import { C, Details, Example, Note, Quickstart, Reference, Section, Steps, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "directory",
  title: "Directory",
  section: "Managing the domain",
  summary: "Users, groups, hosts and organizational units: creating, editing, moving and deleting.",
  keywords: ["user", "group", "host", "computer", "ou", "organizational unit", "csv", "bulk", "password"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          The directory holds four kinds of object: users, groups, hosts and organizational units.
          Organizational units are containers; policy links and delegation scopes attach to them,
          so the structure is worth planning before objects are created.
        </p>

        <Example title="Create an organizational unit">
          <strong>Directory</strong> → select the parent in the tree → <strong>New OU</strong> →
          give it a name.
        </Example>
        <Example title="Create a user">
          Select the organizational unit → <strong>New user</strong> → account name, full name and
          a password. Leave the password empty to create the account disabled.
        </Example>
        <Example title="Add members to a group">
          Select the group → <strong>Members</strong> in the detail panel → search for users, hosts
          or other groups → <strong>Apply</strong>.
        </Example>
        <Example title="Import many users at once">
          <strong>Import CSV</strong> in the toolbar. Columns:{" "}
          <C>sam_account_name, name, given_name, surname, display_name, mail, description, password</C>.
          Only <C>sam_account_name</C> is required. Rows are previewed before anything is created,
          and each row reports its own result.
        </Example>
        <Example title="Move an object">
          Select it → <strong>Move</strong> → choose the destination container.
        </Example>

        <Where>Directory. The tree on the left selects a container; the table lists its contents.</Where>
      </Quickstart>

      <Details>
        <Section title="Object types">
          <Reference
            headers={["Type", "Holds", "Named by"]}
            rows={[
              ["User", "A person's account and its attributes", "Account name, plus a full name used as the object's common name"],
              ["Group", "Users, hosts and other groups", "Group name"],
              ["Host", "A machine account, created by joining or by hand", "Host name; the account name gains a trailing $"],
              ["Organizational unit", "Other objects, and policy links", "Name"],
            ]}
          />
          <Note>
            Built-in containers — Users, Computers, Builtin, System, Domain Controllers — hold
            objects but cannot themselves be moved or deleted. Neither can the built-in principals
            such as Administrator, Domain Admins or krbtgt.
          </Note>
        </Section>

        <Section title="Group scope and kind">
          <p>
            A group has a scope, which controls where it can be used, and a kind, which controls
            whether it can be granted access.
          </p>
          <Reference
            headers={["Scope", "Use"]}
            rows={[
              ["Global", "Members from this domain; usable throughout the forest."],
              ["Domain local", "Members from anywhere; usable in this domain."],
              ["Universal", "Members from anywhere; usable throughout the forest."],
            ]}
          />
          <Reference
            headers={["Kind", "Use"]}
            rows={[
              ["Security", "Can be granted access: policy filtering, sudo rules, HBAC rules, delegation."],
              ["Distribution", "Cannot be granted access. Membership only."],
            ]}
          />
        </Section>

        <Section title="Editable attributes">
          <p>
            The detail panel offers exactly the attributes the control plane accepts for that
            object type. Anything else is rejected.
          </p>
          <Reference
            headers={["Type", "Editable"]}
            rows={[
              [
                "User",
                <C key="u">
                  givenName, sn, displayName, userPrincipalName, mail, telephoneNumber, title,
                  department, company, physicalDeliveryOfficeName, description
                </C>,
              ],
              ["Group", <C key="g">description, mail</C>],
              ["Host", <C key="h">dNSHostName, description</C>],
              ["Organizational unit", <C key="o">description</C>],
            ]}
          />
        </Section>

        <Section title="Accounts">
          <Steps>
            <li>
              <strong>Enable and disable</strong> from the detail panel. A disabled account cannot
              authenticate anywhere in the domain.
            </li>
            <li>
              <strong>Reset a password</strong> from the detail panel. Selecting &ldquo;must change
              at next logon&rdquo; forces a change at the next sign-in.
            </li>
            <li>
              <strong>Creating a user without a password</strong> produces a disabled account.
              Set a password, then enable it.
            </li>
          </Steps>
        </Section>

        <Section title="Searching">
          <p>
            The search box searches the whole domain, not the selected container, and matches
            common name, account name, display name, organizational-unit name and e-mail. The
            object-type filter narrows the result. Results are capped; a truncated result says so.
          </p>
        </Section>

        <Section title="Moving and renaming">
          <p>
            A move changes an object&rsquo;s container. Supplying a new name at the same time
            renames it. Moving an object into itself or into its own subtree is refused. An
            operator with a delegated scope needs the move permission at both the source and the
            destination.
          </p>
          <Note>
            Moving an object between organizational units changes which policy applies to it, and
            which delegated administrators can manage it.
          </Note>
        </Section>

        <Section title="Deleting">
          <p>
            Every delete is a soft delete. The whole object, its group memberships and, for a
            group, its members are snapshotted into the recycle bin before the directory delete
            runs. A container that still holds objects cannot be deleted.
          </p>
        </Section>

        <Section title="Bulk import format">
          <Reference
            headers={["Column", "Meaning"]}
            rows={[
              [<C key="1">sam_account_name</C>, "Required. The logon name."],
              [<C key="2">name</C>, "The object's common name. Defaults to the account name."],
              [<C key="3">given_name</C>, "First name."],
              [<C key="4">surname</C>, "Last name."],
              [<C key="5">display_name</C>, "Display name."],
              [<C key="6">mail</C>, "E-mail address."],
              [<C key="7">description</C>, "Free text."],
              [<C key="8">password</C>, "Initial password. Omitted, the account is created disabled."],
            ]}
          />
          <p>
            Unknown columns are ignored and reported. Rows without an account name are skipped. A
            row that fails does not stop the rest of the import; each row reports its own outcome.
          </p>
        </Section>

        <Section title="Distinguished names">
          <p>
            Every object is identified by its distinguished name, for example{" "}
            <C>CN=ada,OU=Engineering,DC=corp,DC=example,DC=internal</C>. Distinguished names are
            what policy links, delegation scopes and audit entries refer to. A name outside the
            domain head is rejected.
          </p>
        </Section>
      </Details>
    </>
  );
}
