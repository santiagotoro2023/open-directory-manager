import { C, Details, Example, Note, Quickstart, Reference, Section, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "domain-controllers",
  title: "Domain controllers",
  section: "Administration",
  summary: "Which controllers hold the directory, how they replicate, and adding one at a branch.",
  keywords: ["controller", "dc", "rodc", "read-only", "replication", "branch", "site", "join"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          A controller holds the directory, Kerberos and DNS. More than one means the domain
          survives losing a machine, and a read-only one lets a branch office authenticate
          without holding credentials that matter everywhere else.
        </p>

        <Example title="See the state of the domain">
          <strong>Domain Controllers</strong>. Each controller shows whether it is writable or
          read-only, and the replication table below shows what came in from where and whether
          it worked.
        </Example>

        <Example title="Add a controller">
          <strong>Add a controller</strong> → the machine&rsquo;s name, its site, and whether it
          should be read-only. The commands appear; run them on that machine.
        </Example>

        <Where>Domain Controllers.</Where>
      </Quickstart>

      <Details>
        <Section title="Read-only controllers are decided at join time">
          <p>
            Whether a controller is read-only is fixed when it joins the domain, and there is no
            supported path from writable to read-only or back — in ODM, in Samba, or in Windows.
            So this is not a switch on an existing controller: it is a choice when adding one.
          </p>
          <Reference
            headers={["Writable", "Read-only"]}
            rows={[
              [
                "Holds every account's secrets, and changes can be made against it.",
                "Holds no account secrets and accepts no changes; it forwards them to a writable controller.",
              ],
              [
                "What every controller in a single-site domain is.",
                "For a branch where the machine is less well protected than the ones at head office.",
              ],
            ]}
          />
          <Note>
            A read-only controller still needs a writable one reachable to serve a first sign-in
            for an account it has not cached. It reduces what a stolen machine gives away; it
            does not make the branch independent.
          </Note>
        </Section>

        <Section title="Before joining a controller">
          <Reference
            headers={["Requirement", "Why"]}
            rows={[
              [
                "Its resolver points at an existing controller",
                "It finds the domain by service records, which only that DNS answers.",
              ],
              [
                "Its clock is within five minutes",
                "Kerberos refuses a ticket outside that window, and the join is Kerberos.",
              ],
              [
                "Its name is the one it will keep",
                "The computer account, the keytab principal and its certificates all use it.",
              ],
            ]}
          />
        </Section>

        <Section title="Replication">
          <p>
            Samba is multi-master: a change made on any writable controller reaches the others.
            The table reports inbound replication as the controller ODM is running on sees it —
            which partition, from which partner, when it last tried, and how many times in a row
            it has failed.
          </p>
          <Reference
            headers={["Reading", "Means"]}
            rows={[
              ["No inbound partnerships", "One controller. Nothing to replicate."],
              [
                "Consecutive failures rising",
                "Usually DNS or the clock between the two machines. Check both before anything else.",
              ],
              [
                "The account may not read replication state",
                <>
                  Run <C key="a">deploy/create-api-service-account.sh</C> on a controller to
                  grant the right.
                </>,
              ],
            ]}
          />
        </Section>
      </Details>
    </>
  );
}
