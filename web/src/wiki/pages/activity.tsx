import { C, Details, Example, Note, Quickstart, Reference, Section, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "activity",
  title: "Activity",
  section: "Administration",
  summary: "Who signed in where, who used sudo, whose phone approved what — from every machine's own log.",
  keywords: [
    "activity", "sign-in", "login", "sudo", "su", "root", "second factor", "usb", "journal",
    "who did what", "security log", "events",
  ],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          Every machine&rsquo;s agent reads its own journal and reports what people did there:
          each sign-in and failed sign-in, each <C>sudo</C> command and refused one, each switch
          to another user with <C>su</C>, each second factor approved or refused on a phone, each
          password changed, local account added, group membership changed, USB device plugged
          in, and each boot and shutdown. The console&rsquo;s own terminal sessions land in the
          same list. <strong>Activity</strong> shows all of it, across every machine, as one
          table.
        </p>

        <Example title="What did this person do this week?">
          Open the user object → <strong>Activity</strong>. Or on the Activity page, put their
          account name in <strong>Person</strong>.
        </Example>
        <Example title="Who has been using sudo on the file server?">
          Open the computer object → <strong>Activity</strong> → kind{" "}
          <strong>sudo, su and terminals</strong>.
        </Example>
        <Example title="Failed sign-ins anywhere in the last day">
          <strong>Activity</strong> → kind <strong>Sign-ins</strong>, and the{" "}
          <em>Sign-in failed</em> tile counts them.
        </Example>
        <Example title="Hand the list to somebody else">
          <strong>Export CSV</strong> writes whatever the filters currently show.
        </Example>

        <Where>Activity; a computer object → Activity; a user object → Activity.</Where>
      </Quickstart>

      <Details>
        <Section title="What is recorded">
          <Reference
            headers={["Kind", "Read from", "Means"]}
            rows={[
              ["Signed in / Signed out", "PAM session lines; sshd's own Accepted line", "A person opened or closed a session: at the screen, over SSH, over remote desktop. SSH sign-ins carry the address."],
              ["Sign-in failed", "pam_sss and sshd", "The domain refused the password, or no such account. Local-account failures at the screen are not counted, because the local password file refuses every domain account on every sign-in and that noise would drown the real ones."],
              ["sudo / sudo refused", "sudo", "The command, the terminal it was typed at, and — when refused — why: wrong password three times, not in sudoers, command not allowed."],
              ["Became another user / su refused", "su", "Who became whom, on which terminal."],
              ["Console terminal", "the console", "A terminal opened from a computer object's Shell tab; the transcript is in the Audit Log."],
              ["Phone approved / refused / did not answer", "odm-agent", "A second factor asked for on a phone, and what came back, for which way in."],
              ["Second factor set up", "odm-agent", "A phone or a code enrolled through the walkthrough."],
              ["Password changed", "passwd, chpasswd, usermod", "A local password changed on the machine."],
              ["Local account added / removed, group membership changed", "useradd, userdel, usermod, gpasswd", "Changes to the machine's own accounts — a local administrator being made, for instance."],
              ["USB device connected / removed", "the kernel", "The device's vendor and product ids and, where it gave one, its name."],
              ["Booted / Shut down", "wtmp", "The machine's own record of starting and stopping."],
            ]}
          />
        </Section>

        <Section title="How it gets here">
          <p>
            The agent reads the journal since the position it last read to, at every check-in,
            and sends what it found with its inventory. The position only moves once the console
            has taken the report, so a check-in that fails loses nothing and the next one carries
            what it would have. A machine that was off the network reports its backlog when it
            returns, timestamped as it happened. Each report carries at most three hundred events;
            past that, the rest follows on the next check-in rather than being dropped.
          </p>
          <p>
            Sudo commands, second-factor answers and the rest are recorded as their own kinds
            because their programs say exactly what they did. What the list cannot hold is what
            was never logged: a program that writes nothing to the journal leaves nothing here.
          </p>
        </Section>

        <Section title="Who may see it">
          <p>
            The whole domain&rsquo;s activity takes the audit right (<C>audit.read</C>), the same
            as the Audit Log. One machine&rsquo;s activity comes with reading that machine
            (<C>directory.read</C> over it), so a delegated administrator sees what happened on the
            machines in their scope and nothing beyond.
          </p>
          <Note>
            This is what the machines report about themselves. The <strong>Audit Log</strong> is
            what was done through the console. Between the two, a question of the form
            &ldquo;who did what, where, when&rdquo; has an answer on one page or the other.
          </Note>
        </Section>
      </Details>
    </>
  );
}
