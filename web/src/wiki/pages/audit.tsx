import { C, Details, Example, Quickstart, Reference, Section, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "audit",
  title: "Audit log",
  section: "Administration",
  summary: "Every change recorded with actor, time, outcome and before-and-after state.",
  keywords: ["audit", "log", "history", "who changed", "compliance", "diff"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          Every change made through ODM is recorded: who made it, when, from where, what it
          touched, whether it succeeded, and what the object looked like before and after.
          Attempts that were refused are recorded too.
        </p>

        <Example title="Find who changed an object">
          <strong>Audit Log</strong> → put the distinguished name in{" "}
          <strong>Distinguished name</strong> → click a row to expand the before-and-after state.
        </Example>
        <Example title="Review refused actions">
          Set <strong>outcome</strong> to <C>denied</C>.
        </Example>
        <Example title="Review one operator">
          Put their account name in <strong>Actor</strong>.
        </Example>

        <Where>Audit Log.</Where>
      </Quickstart>

      <Details>
        <Section title="What an entry holds">
          <Reference
            headers={["Field", "Meaning"]}
            rows={[
              ["Time", "When it happened."],
              ["Actor", "The principal that made the change, or system for scheduled work."],
              ["Source address", "Where the request came from."],
              ["Action", <>A dotted name such as <C key="a">user.create</C> or <C key="b">gpo.link</C>.</>],
              ["Object", "The distinguished name or identifier that was touched."],
              ["Outcome", "success, denied or failure."],
              ["Before and after", "The object's state on each side of the change."],
              ["Detail", "A short explanation, such as why something was refused."],
            ]}
          />
        </Section>

        <Section title="Outcomes">
          <Reference
            headers={["Outcome", "Means"]}
            rows={[
              ["success", "The change was made."],
              [
                "denied",
                "The request was refused: a missing permission, a protected object, invalid input, or a sign-in that was not allowed.",
              ],
              ["failure", "The change was attempted and something went wrong."],
            ]}
          />
        </Section>

        <Section title="Action names">
          <Reference
            headers={["Prefix", "Covers"]}
            rows={[
              [<C key="1">auth.</C>, "Sign-in, sign-out and session revocation."],
              [<C key="2">user. group. computer. ou. object.</C>, "Directory objects."],
              [<C key="3">gpo.</C>, "Policy objects, links, inheritance and the defaults."],
              [<C key="4">admx.</C>, "Administrative template imports and removals."],
              [<C key="5">dns.</C>, "Zones and records."],
              [<C key="6">dhcp.</C>, "Scopes and reservations."],
              [<C key="7">ca.</C>, "Certificate issuing, revocation, publishing and the console certificate."],
              [<C key="8">rbac.</C>, "Roles and assignments."],
              [<C key="9">role.</C>, "Server role installation and deregistration."],
              [<C key="10">recyclebin.</C>, "Restores and purges."],
              [<C key="11">backup. replication.</C>, "Backups and forced replication."],
            ]}
          />
        </Section>

        <Section title="Properties">
          <p>
            The log is append-only: entries cannot be edited or deleted, and the database enforces
            it. Passwords never appear in it — the state written for a change is read back from the
            directory, which never returns a password.
          </p>
        </Section>

        <Section title="What is not in it">
          <p>
            Changes made directly against the directory or the DHCP service with other tools are
            not recorded here; only what goes through ODM is.
          </p>
        </Section>
      </Details>
    </>
  );
}
