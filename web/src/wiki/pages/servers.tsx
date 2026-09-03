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
  id: "servers",
  title: "Member servers",
  section: "Administration",
  summary: "Joining a machine, giving it a role, and how work reaches one that is not a controller.",
  keywords: ["server", "member", "node", "fleet", "estate", "agent", "task", "distribute"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          A domain is more than its controllers. Any joined machine can carry a role — a file
          server, a DHCP node, a certificate authority. Each machine is a computer object under{" "}
          <strong>Directory</strong>, where its software, local accounts, sign-in history, logs and
          updates are; <strong>Server Roles</strong> is where roles are installed on it.
        </p>

        <Example title="Add a server to the domain">
          On the machine:{" "}
          <C>sudo odm-client-install --domain corp.example.internal --admin-user Administrator</C>.
          It appears here once its agent reports.
        </Example>

        <Example title="Give a server a role">
          <Steps>
            <li>
              <strong>Server Roles</strong> → the role → <strong>Install on a server</strong>.
            </li>
            <li>
              <strong>Select…</strong> and choose the machine. Any joined computer is offered, not
              only controllers.
            </li>
            <li>
              The role sits at <C>installing</C> until that machine&rsquo;s agent picks the work up,
              then moves to <C>active</C> or <C>failed</C> with a reason.
            </li>
          </Steps>
        </Example>

        <Example title="See what one machine runs">
          Click it. The dialog lists its roles, its operating system, and when its agent last
          reported.
        </Example>

        <Where>Directory for the machine itself; Server Roles for what it carries.</Where>
      </Quickstart>

      <Details>
        <Section title="How work reaches another machine">
          <p>
            The control plane can only run a command on its own host. Anything it needs done
            elsewhere is queued and collected by that machine&rsquo;s agent, which already proves
            which machine it is with the Kerberos identity domain join gave it. No second
            credential, and no inbound connection to the member server.
          </p>
          <Reference
            headers={["Task", "Queued by", "Done by"]}
            rows={[
              ["Installing a role", "Server Roles → Install", "the agent, from /usr/lib/odm/roles"],
              ["Creating or editing a share", "File Shares", "the agent, with setfacl and Samba"],
              ["Removing a share", "File Shares → Stop sharing", "the agent"],
            ]}
          />
          <Note>
            A task is claimed by exactly one poll, so an install that takes minutes is not started
            again by the next check-in.
          </Note>
        </Section>

        <Section title="What each column means">
          <Reference
            headers={["Column", "Reading"]}
            rows={[
              ["Server", "The computer account's name. A controller is marked."],
              ["Runs", "Roles registered on this machine, and any work still queued for it."],
              ["Operating system", "As the directory recorded it at join time."],
              [
                "Agent",
                "When the machine last reported. A machine that never reports applies no policy and takes no tasks.",
              ],
            ]}
          />
        </Section>

        <Section title="Running a command on a machine">
          <p>
            A computer object has a <strong>Shell</strong> tab. What is typed there runs as root on
            that machine and its output comes back &mdash; a round trip of about a second, because
            the agent already holds a request open for work.
          </p>
          <p>
            It is not a terminal. Each command starts fresh, so a <C>cd</C> does not carry to the
            next one and nothing can be typed at a prompt: a command that stops to ask a question
            waits until its timeout and is killed. Write one line that does the whole thing.
          </p>
          <Note>
            This is root on that machine, so it is its own right rather than something that comes
            with reading a computer object, and it is checked against that machine the way any
            other change to it is. Every command is written to the audit log with who ran it, from
            where, and what came back &mdash; including the ones that failed.
          </Note>
        </Section>

        <Section title="Updating a machine's agent">
          <p>
            The <strong>Machine</strong> tab shows what the agent on that machine is and what this
            console would hand it, with a button to update it. For a fleet rather than one machine,
            the <strong>Agent updates</strong> policy setting does the same thing on a schedule.
          </p>
          <p>
            The console hands out the binary it was deployed with &mdash; the one{" "}
            <C>deploy/setup.sh</C> installs beside the API. Publish a release, run that script on
            the controller, and every machine set to install takes it at its next refresh.
          </p>
        </Section>

        <Section title="A machine that never reports">
          <Reference
            headers={["Check", "How"]}
            rows={[
              ["Is the agent running?", <C key="a">systemctl status odm-agent</C>],
              ["Can it reach the control plane?", <C key="b">odm-agent apply --force</C>],
              ["Does it have a keytab?", <C key="c">klist -k /etc/krb5.keytab</C>],
            ]}
          />
        </Section>
      </Details>
    </>
  );
}
