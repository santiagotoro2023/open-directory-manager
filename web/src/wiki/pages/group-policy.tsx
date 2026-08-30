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
  id: "group-policy",
  title: "Group Policy",
  section: "Managing the domain",
  summary: "Policy objects, links, precedence, inheritance, filtering and item-level targeting.",
  keywords: [
    "gpo",
    "policy",
    "link",
    "precedence",
    "enforced",
    "block inheritance",
    "rsop",
    "targeting",
    "wmi",
  ],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          A group policy object is a named set of settings. It does nothing until it is linked to a
          container. A machine receives every policy object linked at its own organizational unit
          and at every container above it, merged into one effective policy.
        </p>

        <Example title="Create and apply a policy">
          <Steps>
            <li>
              <strong>Group Policy</strong> → <strong>New GPO</strong> → give it a name.
            </li>
            <li>
              <strong>Settings</strong> → pick a category from the list, under{" "}
              <strong>Computer</strong> or <strong>User</strong> → <strong>Add</strong>. A category
              carrying settings shows how many.
            </li>
            <li>
              <strong>Links</strong> → pick a container → <strong>Link here</strong>.
            </li>
            <li>
              <strong>Save</strong>. Agents pick it up on their next refresh, or immediately with{" "}
              <C>odm-agent apply --force</C>.
            </li>
          </Steps>
        </Example>

        <Example title="Make a policy win over one set closer to the object">
          On the <strong>Links</strong> tab, tick <strong>Enforced</strong>.
        </Example>
        <Example title="Stop inherited policy reaching an organizational unit">
          <strong>Directory</strong> → select the organizational unit →{" "}
          <strong>Block inheritance</strong>.
        </Example>
        <Example title="See what a machine will get">
          <strong>Directory</strong> → select the computer → <strong>Policy</strong>.
        </Example>
        <Example title="Delete a policy object">
          Open it → <strong>Delete</strong>. Its links go with it, and it is restorable from{" "}
          <strong>Deleted Objects</strong> within the retention window.
        </Example>

        <Where>
          Group Policy for the objects; Directory for inheritance and per-object results.
        </Where>
      </Quickstart>

      <Details>
        <Section title="How precedence is decided">
          <p>Policy objects are applied in this order, and the last one to set a value wins.</p>
          <Steps>
            <li>
              <strong>From the domain head down.</strong> A policy linked at the object&rsquo;s own
              organizational unit is applied after one linked at the domain, so it overrides it.
            </li>
            <li>
              <strong>By link order within a container.</strong> Link order 1 has the highest
              precedence, so links are applied in descending order and the lowest number wins.
            </li>
            <li>
              <strong>Enforced links last.</strong> An enforced link is applied after every
              unenforced one, so it wins regardless of distance.
            </li>
            <li>
              <strong>Among enforced links, the highest in the hierarchy wins.</strong> An enforced
              link at the domain head beats an enforced link on an organizational unit.
            </li>
          </Steps>
        </Section>

        <Section title="Blocking inheritance">
          <p>
            An organizational unit with inheritance blocked discards everything linked above it.
            Enforced links are the exception: they still apply. Blocking is set on the
            organizational unit, not on the policy object.
          </p>
        </Section>

        <Section title="Security filtering">
          <p>
            A policy object with no security filter applies to everything in scope. Adding
            distinguished names restricts it to those principals and to anything that is a member of
            them, nesting included. A machine that is not in the filter is skipped, and the reason
            is reported.
          </p>
        </Section>

        <Section title="Item-level targeting">
          <p>
            Targeting narrows a policy object further, evaluated against facts the machine reports
            when it asks for its policy. All conditions that are set must match.
          </p>
          <Reference
            headers={["Condition", "Matches against", "Example"]}
            rows={[
              ["Operating systems", "The client's own identifier", <C key="1">debian-13</C>],
              [
                "Host name pattern",
                "The machine's host name, shell-style wildcards",
                <C key="2">ws-*</C>,
              ],
              ["Groups", "Group membership, nesting included", "A distinguished name per line"],
              ["IP ranges", "The machine's current addresses", <C key="3">10.10.0.0/16</C>],
            ]}
          />
        </Section>

        <Section title="Links">
          <Reference
            headers={["Control", "Effect"]}
            rows={[
              ["Link order", "Precedence within one container. 1 is highest."],
              ["Enforced", "Applied after everything else and survives blocked inheritance."],
              ["Link enabled", "Turning it off stops this link applying without deleting it."],
            ]}
          />
          <p>
            A policy object can be linked to any number of containers. Removing the last link stops
            it applying anywhere without deleting the settings.
          </p>
        </Section>

        <Section title="Default policies">
          <p>
            Two policy objects are created for a new domain and behave like any other afterwards.
          </p>
          <Reference
            headers={["Policy", "Linked to", "Contains"]}
            rows={[
              [
                "Default Domain Policy",
                "The domain head",
                <>
                  A logon banner at <C>/etc/issue.net</C> and the agent refresh interval.
                </>,
              ],
              [
                "Default Domain Controllers Policy",
                "The Domain Controllers organizational unit",
                "SSH enabled, and session access granted to the domain administrators group.",
              ],
            ]}
          />
        </Section>

        <Section title="Resultant Set of Policy">
          <p>The Policy dialog on any object answers two separate questions.</p>
          <Reference
            headers={["Question", "Where it comes from"]}
            rows={[
              [
                "What should apply?",
                "Resolved live from the policy objects, links, filtering and targeting. Shows the applied objects in precedence order and every skipped object with its reason.",
              ],
              [
                "What did apply?",
                "The machine's own last report, with per-setting success, failure or skip, and whether the report matches the current policy.",
              ],
            ]}
          />
        </Section>

        <Section title="Interoperability">
          <p>
            When the control plane runs on a domain controller and <C>ODM_SYSVOL_PATH</C> is
            configured, each policy object is mirrored into the directory as a group policy
            container with a SYSVOL directory, links are written to <C>gPLink</C> on each target,
            and blocked inheritance is written to <C>gPOptions</C>.
          </p>
          <Note>
            The mirror is off after a standard install. Turning it on requires the control-plane
            service account to be able to write Samba&rsquo;s SYSVOL share, and{" "}
            <C>ReadWritePaths</C> in the service unit extended to cover it. Without it, policy
            objects exist only in ODM: agents are unaffected, and external group policy tooling does
            not see them.
          </Note>
        </Section>
      </Details>
    </>
  );
}
