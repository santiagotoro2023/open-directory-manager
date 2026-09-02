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
  id: "directory",
  title: "Directory",
  section: "Managing the domain",
  summary:
    "Users, groups, computers and organizational units: creating, editing, moving and deleting.",
  keywords: ["user", "group", "computer", "ou", "organizational unit", "csv", "bulk", "password"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          The directory holds four kinds of object: users, groups, computers and organizational
          units. Organizational units are containers; policy links and delegation scopes attach to
          them, so the structure is worth planning before objects are created.
        </p>

        <Example title="Create an organizational unit">
          <strong>Directory</strong> → select the parent in the tree → <strong>Create…</strong> →{" "}
          <strong>Organizational unit</strong> → give it a name.
        </Example>
        <Example title="Create a user">
          Select the organizational unit → <strong>Create…</strong> → <strong>User</strong> →
          account name, full name and a password. Leave the password empty to create the account
          disabled.
        </Example>
        <Example title="Create a group">
          Select the organizational unit → <strong>Create…</strong> → <strong>Group</strong> → name
          it, choose <strong>User group</strong> or <strong>Computer group</strong>.
        </Example>
        <Example title="Add members to a group">
          Select the group → <strong>Members</strong> in the detail panel → search →{" "}
          <strong>Apply</strong>. A user group offers people; a computer group offers computers.
        </Example>
        <Example title="Import many users at once">
          <strong>Import CSV</strong> in the toolbar. Columns:{" "}
          <C>
            sam_account_name, name, given_name, surname, display_name, mail, description, password
          </C>
          . Only <C>sam_account_name</C> is required. Rows are previewed before anything is created,
          and each row reports its own result.
        </Example>
        <Example title="Move an object">
          Open it → <strong>Move</strong> → choose the destination container.
        </Example>
        <Example title="See what a machine is doing">
          Open a computer → <strong>Machine</strong> for its operating system, uptime and pending
          updates, <strong>Local users</strong> for the accounts on it, <strong>Activity</strong>{" "}
          for who signed in and when it booted.
        </Example>
        <Example title="See why a machine is unhappy">
          Open the computer → <strong>Logs</strong>. Warnings and errors from its journal, grouped
          by the unit that produced them; groups with errors open first. Choose how far back at the
          top right.
        </Example>
        <Example title="See and change what is installed">
          Open the computer → <strong>Software</strong>. The list is the packages somebody asked
          for, not the dependencies behind them. <strong>Install a package</strong> adds one from
          the sources the machine already has; <strong>Uninstall</strong> removes one.
        </Example>
        <Example title="Restart a machine">
          Open the computer → <strong>Machine</strong> → <strong>Restart</strong>. Anyone signed in
          is named before it is confirmed.
        </Example>
        <Example title="Update a machine now">
          Open the computer → <strong>Machine</strong> → <strong>Check for updates</strong> or{" "}
          <strong>Install updates</strong>. The machine&rsquo;s agent holds a request open with the
          control plane, so the work starts within a second unless the machine is off — in which
          case it starts when the machine comes back, or immediately with{" "}
          <C>odm-agent apply --force</C> on it.
        </Example>
        <Example title="Add or remove a local account on one machine">
          Open the computer → <strong>Local users</strong> → <strong>New local account</strong>.
          This account exists on that machine alone; for one that works across the domain, create a
          user in the directory instead. Leaving the password empty creates it with password login
          locked, which is what a service account wants. Adding it to <C>sudo</C> makes it an
          administrator there. The bin icon removes an account and its home directory; system
          accounts (uid below 1000) cannot be removed from here.
        </Example>

        <Example title="Show the containers the directory keeps for itself">
          <strong>Show system containers</strong> at the foot of the tree. Off by default, it
          reveals <C>System</C>, <C>Program Data</C>, <C>Keys</C> and the rest.
        </Example>

        <Where>
          Directory. The tree on the left selects a container; the table lists its contents.
          Clicking an object opens its own page. The root is the domain&rsquo;s short name, and the
          border between the tree and the table can be dragged.
        </Where>
      </Quickstart>

      <Details>
        <Section title="Object types">
          <Reference
            headers={["Type", "Holds", "Named by"]}
            rows={[
              [
                "User",
                "A person's account and its attributes",
                "Account name, plus a full name used as the object's common name",
              ],
              ["Group", "People or computers, and other groups", "Group name"],
              [
                "Computer",
                "A machine account, created by joining or by hand",
                "Computer name; the account name gains a trailing $",
              ],
              ["Organizational unit", "Other objects, and policy links", "Name"],
            ]}
          />
          <Note>
            Built-in containers — Users, Computers, Builtin, System, Domain Controllers — hold
            objects but cannot themselves be moved or deleted. Neither can the built-in principals
            such as Administrator, Domain Admins or krbtgt.
          </Note>
        </Section>

        <Section title="User groups and computer groups">
          <p>
            Every group is either a <strong>user group</strong> or a <strong>computer group</strong>
            . The type decides what the member picker offers and how the group is labelled; it is
            set when the group is created and can be changed afterwards from the group&rsquo;s
            detail panel.
          </p>
          <Reference
            headers={["Type", "Holds", "Typically used for"]}
            rows={[
              [
                "User group",
                "People, and other groups",
                "Sudo rules, HBAC rules, drive maps assigned to a group, delegation, group policy filtering",
              ],
              [
                "Computer group",
                "Computers, and other groups",
                "Group policy filtering and item-level targeting by machine",
              ],
            ]}
          />
          <p>
            Both types can be granted access. A group ODM has not classified — one created outside
            the console — is shown as a user group until it is changed.
          </p>
        </Section>

        <Section title="Group scope">
          <p>Scope controls where in the forest a group can be used.</p>
          <Reference
            headers={["Scope", "Members from", "Usable in"]}
            rows={[
              ["Global", "This domain", "Anywhere in the forest"],
              ["Domain local", "Anywhere", "This domain"],
              ["Universal", "Anywhere", "Anywhere in the forest"],
            ]}
          />
          <Note>
            Scope is fixed when the group is created. To change it, create a new group and move the
            membership across.
          </Note>
        </Section>

        <Section title="Editable attributes">
          <p>
            The detail panel offers exactly the attributes the control plane accepts for that object
            type. Anything else is rejected.
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
              ["Computer", <C key="h">dNSHostName, description</C>],
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
              <strong>Creating a user without a password</strong> produces a disabled account. Set a
              password, then enable it.
            </li>
          </Steps>
        </Section>

        <Section title="Pictures">
          <p>
            A person&rsquo;s picture is set on their account and shown by every machine they sign
            in to &mdash; at the login screen and in the desktop. Set it once here rather than on
            each desktop, where it would stay on the desktop it was set on.
          </p>
          <p>
            It is stored in <C>thumbnailPhoto</C>, which is where Active Directory keeps it, and
            written to the machine at each logon. Keep it small: a picture, not a portrait
            session.
          </p>
          <Where>Directory &rarr; a user &rarr; Actions &rarr; Picture.</Where>
        </Section>

        <Section title="Searching">
          <p>
            The search box searches the whole domain, not the selected container, and matches common
            name, account name, display name, organizational-unit name and e-mail. The object-type
            filter narrows the result. Results are capped; a truncated result says so.
          </p>
        </Section>

        <Section title="Moving and renaming">
          <p>
            A move changes an object&rsquo;s container. Supplying a new name at the same time
            renames it. Moving an object into itself or into its own subtree is refused. An operator
            with a delegated scope needs the move permission at both the source and the destination.
          </p>
          <Note>
            Moving an object between organizational units changes which policy applies to it, and
            which delegated administrators can manage it.
          </Note>
        </Section>

        <Section title="Deleting">
          <p>
            Every delete is a soft delete. The whole object, its group memberships and, for a group,
            its members are snapshotted into the recycle bin before the directory delete runs. A
            container that still holds objects cannot be deleted.
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
              [
                <C key="8">password</C>,
                "Initial password. Omitted, the account is created disabled.",
              ],
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
