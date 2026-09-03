import {
  C,
  Code,
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
  id: "remote-desktop",
  title: "Remote desktop",
  section: "Administration",
  summary:
    "Collections, session hosts, a broker that sends people back to the same host, and profile disks.",
  keywords: [
    "remote desktop",
    "rds",
    "rdp",
    "session host",
    "broker",
    "collection",
    "xrdp",
    "profile disk",
    "upd",
    "remoteapp",
    "terminal server",
  ],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          A <strong>collection</strong> is a set of session hosts serving the same thing to the same
          people. People connect to the <strong>broker</strong>, never to a host, and the broker
          sends each person back to the host they were last on &mdash; so reconnecting resumes the
          session they left rather than opening a second one beside it.
        </p>

        <Steps>
          <li>
            Install <strong>Remote desktop broker</strong> on one machine and{" "}
            <strong>Remote desktop session host</strong> on the machines that will serve desktops,
            under <strong>Server Roles</strong>.
          </li>
          <li>
            Make a share for profiles under <strong>File Shares</strong>. Every person gets a disk
            on it.
          </li>
          <li>
            <strong>Remote Desktop</strong> &rarr; <strong>New collection</strong>: name it and
            choose the broker, then what people get, the profile share, the session limits and who
            may connect. <strong>Show every setting</strong> puts them on one page.
          </li>
          <li>
            <strong>Session hosts</strong> tab &rarr; add hosts to the collection.
          </li>
          <li>
            <strong>Connection file</strong> on the collection hands you a <C>.rdp</C> for one
            person, which opens in any RDP client.
          </li>
        </Steps>

        <Where>Remote Desktop, once a broker exists.</Where>
      </Quickstart>

        <Section title="What a session host needs">
          <p>
            A server with no graphical environment on it. Installing the role puts one there: xrdp,
            xorgxrdp and Xfce, which is the desktop each session starts. GNOME is not required and
            is not installed.
          </p>
          <Reference
            headers={["Part", "Comes from"]}
            rows={[
              ["The desktop", "xfce4, installed by the role."],
              ["The X server", "xorgxrdp, one per session, started by xrdp-sesman."],
              [
                "Sessions without a seat",
                <>
                  Debian&rsquo;s Xorg wrapper only lets somebody at the machine start an X server;
                  the role sets <C key="w">allowed_users=anybody</C>, because a session host&rsquo;s
                  whole job is starting them for people who are not at it.
                </>,
              ],
              ["Certificates", "A self-signed pair, replaced by the CA role's issued one."],
            ]}
          />
          <Note>
            A machine that already runs a desktop can carry the role as well; xrdp starts its own
            session rather than attaching to the one on the console.
          </Note>
        </Section>

      <Details>
        <Section title="Why everything is on the collection">
          <p>
            Almost nothing is configured on a session host. Which desktop people get, where their
            profile lives, when a session ends and who may connect are all the collection&rsquo;s,
            because they are decided once for everybody. A host&rsquo;s own configuration is only
            what is true of that machine whatever collection it ends up in.
          </p>
          <p>
            That is also why a host may serve exactly one collection. Two would share a desktop and
            a profile share while claiming to be separate.
          </p>
        </Section>

        <Section title="How the broker sends somebody to the same host">
          <p>
            An RDP client puts the user name in its first packet, as a cookie the protocol calls{" "}
            <C>mstshash</C>. The broker keeps a table of which name went to which host and routes on
            it. That is the affinity a Windows connection broker provides, and it is why the
            connection file carries the user name: without it somebody lands on whichever host is
            least busy each time, which is the opposite of what a collection is for.
          </p>
          <Note>
            The routing is haproxy in TCP mode, which reads that cookie natively. ODM writes its
            configuration and implements no part of RDP itself.
          </Note>
        </Section>

        <Section title="Which host somebody lands on">
          <p>Two different questions, and the broker answers them differently.</p>
          <Reference
            headers={["Who", "Where they go"]}
            rows={[
              [
                "Somebody who already has a session",
                "Back to the host it is on, always. Their profile disk is mounted there and nowhere else, so this is not a preference.",
              ],
              [
                "Somebody with no session yet",
                "Spread across the collection by the method below. They can land on any host, because their profile is a disk on the share rather than files on one machine.",
              ],
            ]}
          />
          <Reference
            headers={["Send a new session to", "Means", "Use it when"]}
            rows={[
              [
                "The host with the fewest sessions",
                "Whichever host is carrying the least.",
                "The default, and what most people mean by spreading load.",
              ],
              [
                "Each host in turn",
                "Strict round robin, ignoring how busy a host is.",
                "Hosts are identical and you want an even count rather than an even load.",
              ],
              [
                "The first host with room, then the next",
                "Fills one host before touching the next.",
                "You want to be able to shut idle hosts down, or you are paying per running machine.",
              ],
            ]}
          />
          <Note>
            The broker holds somebody to their host for as long as their session could still exist
            &mdash; derived from the collection&rsquo;s disconnected timeout, not a fixed number.
            That matters: if the affinity expired first, they would land on another host, that host
            could not mount a profile disk the old host still holds, and the logon would be refused.
            When sessions are kept indefinitely, so is the affinity.
          </Note>
        </Section>

        <Section title="Profile disks">
          <p>
            Each person gets one disk image on the profile share, named for their account and
            mounted over their home directory when they sign in. It follows them to whichever host
            answers. <C>%username%</C> after the share gives each person their own directory in
            it, and is made if it is not there.
          </p>
          <Code>{`//fs01/rds-profiles/%username%  →  //fs01/rds-profiles/jdoe/UPD-jdoe.img`}</Code>
          <p>
            It is named for the account and nothing else &mdash; a uid does not travel between
            machines, and naming the disk after one meant a different profile on every host. That
            is also the same layout a roaming-profile policy uses, so give a collection its own
            share unless one profile everywhere is what you want; see the row below.
          </p>
          <Reference
            headers={["Property", "Means"]}
            rows={[
              [
                "Size",
                "The image is created at the size the collection sets and cannot exceed it. It is sparse, so it takes the space it is using.",
              ],
              [
                "One host at a time",
                "Inside a collection, the broker sends somebody back to the host already holding their session, so only that host has their disk. It cannot see a physical desktop: point a roaming-profile policy and a collection at the same share and somebody signed in at their desk and over RDP at once has one disk image mounted from two machines, which corrupts it. Give the collection its own share unless people use one or the other.",
              ],
              [
                "Optional",
                "Leave the profile share empty and sessions use whatever home directory the host already gives somebody. Right for a single session host; wrong for a farm, where a profile that stays on one host is a different profile on every other one.",
              ],
            ]}
          />
          <Note>
            A profile that cannot be attached leaves that session with a local home and says why
            in the journal. It used to fail the whole PAM session instead, which to the session
            manager is &ldquo;Can&rsquo;t create session for user&rdquo; &mdash; one unreachable
            share and nobody on the farm could sign in at all.
          </Note>
        </Section>

        <Section title="Full desktops and published applications">
          <p>
            A collection serves either a whole desktop or one application. A published application
            replaces the desktop rather than sitting on top of one, so closing it ends the session
            &mdash; which is what somebody handed a single program expects. Windows calls this
            RemoteApp.
          </p>
          <Example title="A line-of-business application">
            Session: <strong>One published application</strong>, program <C>/usr/bin/erp-client</C>.
            The connection file opens that window and no desktop around it.
          </Example>
        </Section>

        <Section title="What belongs in a policy object instead">
          <p>
            What a session may carry between the client and the host is a rule about machines, not
            about who connects to what &mdash; an organisation usually wants one rule everywhere and
            an exception for a group. So it is <strong>Group Policy</strong> &rarr;{" "}
            <strong>Computer</strong> &rarr; <strong>Remote desktop session</strong>, linked where
            it should apply.
          </p>
          <Reference
            headers={["Setting", "Default", "Why"]}
            rows={[
              ["Clipboard", "On", "Copy and paste between the client and the session."],
              [
                "The client's printers",
                "On",
                "Printing from the session to a printer beside the person.",
              ],
              [
                "The client's drives",
                "Off",
                "This is the client's own filesystem inside the session, and the usual way data leaves a managed desktop.",
              ],
              ["Sound to the client", "On", "Audio out."],
              ["The client's microphone", "Off", "Audio in."],
              ["Most colour depth", "32-bit", "Lower is less to send, which shows on a slow link."],
            ]}
          />
          <Note>
            Who may sign in to a session host at all is an HBAC rule, the same as for any other
            machine. The collection decides who the desktop is <em>for</em>; HBAC decides who the
            machine will accept.
          </Note>
        </Section>

        <Section title="Remote desktop files">
          <p>
            Handing out <C>.rdp</C> files is the part of a rollout that never finishes: whoever
            joins next has no icon, whoever leaves keeps theirs. So it is a policy setting &mdash;{" "}
            <strong>Group Policy</strong> &rarr; <strong>User</strong> &rarr;{" "}
            <strong>Remote desktop files</strong> &mdash; naming a collection and a group. The file
            appears on the desktop of everybody in that group when they sign in, and goes when the
            membership goes or the policy object is unlinked.
          </p>
          <Reference
            headers={["Field", "What it is"]}
            rows={[
              ["Name", "What the icon says, and the file's name. Starts as the collection's name."],
              [
                "Broker",
                "Where the file connects to. Select… on any of these three fields opens the collection picker and fills all of them, so it is never a session host by mistake.",
              ],
              [
                "Published application",
                "Set from the collection: empty for a whole desktop, the application's alias for a RemoteApp collection.",
              ],
              ["For user or group", "Who gets it. Empty means everybody the policy object reaches."],
              ["Full screen", "Whether the session opens full screen or in a window."],
            ]}
          />
          <Example title="One collection, one group, no manual work">
            A collection <C>Terminal Server</C> and a group <C>rd-terminal-server</C>. The entry
            names both; adding somebody to the group gives them the icon at their next sign-in, and
            removing them takes it away at theirs.
          </Example>
          <Note>
            The file carries the broker, the account in <C>DOMAIN\user</C> form and the session
            settings; it carries no password. It is written into the desktop directory the
            session actually uses, which a localised desktop calls something else.
          </Note>
        </Section>

        <Section title="Sessions and timeouts">
          <Reference
            headers={["Setting", "Means"]}
            rows={[
              [
                "Sign out after idle",
                "Minutes with no input before the session ends. 0 never, as in Windows.",
              ],
              [
                "End disconnected after",
                "Minutes a session is kept after the client goes away, so a reconnect finds it. 0 keeps it indefinitely.",
              ],
              ["Most sessions per host", "A cap so one host does not take everybody. 0 no limit."],
            ]}
          />
          <p>
            The <strong>Sessions</strong> tab is the session directory: who is on which host, as the
            hosts last reported it. It is how you tell where a reconnect will land.
          </p>
        </Section>

        <Section title="What is installed">
          <Reference
            headers={["Role", "Installs", "Listens"]}
            rows={[
              [
                "Remote desktop session host",
                <C key="a">xrdp, xorgxrdp, xfce4, cifs-utils</C>,
                "3389/tcp",
              ],
              ["Remote desktop broker", <C key="b">haproxy</C>, "3389/tcp"],
            ]}
          />
          <Note>
            A session host must be domain-joined before the role installs: it authenticates domain
            accounts through SSSD, and there is nothing for it to serve otherwise.
          </Note>
        </Section>

        <Section title="When something does not connect">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                "The broker refuses connections",
                "The collection has no session hosts. Add one under Session hosts; until then there is nothing to route to.",
              ],
              [
                "Signing in is refused on a host that is up",
                "The profile disk could not be mounted. That is deliberate — check the profile share is reachable from that host and that its machine account may write to it.",
              ],
              [
                "Somebody lands on a different host each time",
                "Their connection file has no user name in it. Download a fresh one from the collection.",
              ],
              [
                "The collection state is failed",
                "Server Roles → the role → the failed server shows the installer's output.",
              ],
            ]}
          />
        </Section>
        <Section title="Ports">
          <p>
            Clients connect to the broker, never to a host, so the broker owns 3389. A session
            host on the <em>same</em> machine as the broker is moved to 3390 automatically and the
            broker is told to reach it there — otherwise both would bind 3389, xrdp would win, and
            every client would land on that one host with no balancing and no affinity.
          </p>
          <Reference
            headers={["Listens on", "What"]}
            rows={[
              ["3389", "The broker. This is the address people type."],
              ["3389", "A session host on its own machine."],
              ["3390", "A session host sharing a machine with the broker."],
            ]}
          />
        </Section>

      </Details>
    </>
  );
}
