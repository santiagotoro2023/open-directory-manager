import { Details, Example, Note, Quickstart, Reference, Section, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "deleted-objects",
  title: "Deleted objects",
  section: "Administration",
  summary: "Restoring and purging what has been deleted, and how long it is kept.",
  keywords: ["recycle bin", "restore", "undelete", "purge", "retention", "deleted"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          Every delete made through ODM is a soft delete. The whole object, its group memberships
          and, for a group, its members are captured before the directory delete runs, and kept for
          the retention window.
        </p>

        <Example title="Restore something">
          <strong>Deleted Objects</strong> → find it → <strong>Restore</strong>. It is recreated in
          the container it came from and rejoined to the groups it belonged to.
        </Example>

        <Example title="Purge something immediately">
          <strong>Deleted Objects</strong> → the bin icon on the row. The snapshot is destroyed and
          cannot be recovered.
        </Example>

        <Where>Deleted Objects.</Where>
        <Example title="Restore into a different container">
          <strong>Restore</strong> → <strong>Restore into</strong> → <strong>Select…</strong>. It
          defaults to where the object came from; change it when that container was deleted too.
        </Example>

      </Quickstart>

      <Details>
        <Section title="What a snapshot holds">
          <Reference
            headers={["Captured", "Restored"]}
            rows={[
              ["Every attribute of the object", "Yes, apart from the ones the directory owns"],
              ["The groups it belonged to", "Yes, where those groups still exist"],
              ["Its members, if it was a group", "Yes"],
              ["Its security identifier and object GUID", "No — the directory issues new ones"],
              ["Its password", "No"],
            ]}
          />
        </Section>

        <Section title="After a restore">
          <Note>
            A restored object has a new security identifier. Access rules elsewhere that named the
            old identifier do not follow it and need re-granting.
          </Note>
          <p>
            Restored accounts come back disabled, because a snapshot carries no password. Set a
            password, then enable the account.
          </p>
          <p>
            A restore fails if the container the object came from has itself been deleted, or if an
            object already exists at that name. Restore the container first, or create it.
          </p>
        </Section>

        <Section title="Retention">
          <p>
            Snapshots are kept for the configured window, 180 days by default, then purged
            automatically by a sweep that runs hourly. Purging destroys the directory data and
            leaves a record that the purge happened. Both automatic and manual purges are audited.
          </p>
        </Section>

        <Section title="What is not covered">
          <p>
            Only deletes made through ODM are captured. An object deleted with another tool directly
            against the directory leaves no snapshot.
          </p>
          <p>
            A container that still holds objects cannot be deleted, so a restore never has to
            rebuild a subtree.
          </p>
        </Section>
      </Details>
    </>
  );
}
