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
  id: "printing",
  title: "Printing",
  section: "Administration",
  summary: "Printers on a print server, and handing them to the right people.",
  keywords: ["printer", "print", "cups", "ppd", "driver", "ipp", "queue", "duplex"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          A printer is defined once on a print server. Clients get it from that server rather than
          driving the hardware themselves, so nothing is installed on a workstation: the server
          holds the queue and the driver.
        </p>

        <Example title="Publish a printer">
          <Steps>
            <li>
              <strong>Server Roles</strong> → <strong>Print server</strong> →{" "}
              <strong>Install on a server</strong>, if that machine does not carry the role yet.
            </li>
            <li>
              <strong>Printers</strong> → <strong>New printer</strong> → pick the server, name it,
              and give the address the server reaches the printer at.
            </li>
            <li>
              Leave <strong>Driverless</strong> selected unless the printer is old enough to need a
              PPD.
            </li>
            <li>
              <strong>Create</strong>. The state moves from <C>applying</C> to <C>active</C> when
              the server&rsquo;s agent has configured it.
            </li>
          </Steps>
        </Example>

        <Example title="Give people a printer">
          <strong>Group Policy</strong> → the policy object → <strong>Settings</strong> →{" "}
          <strong>User</strong> → <strong>Printers</strong> → <strong>Add</strong>. Name the printer
          and its server, choose the group with <strong>Select…</strong>, and tick{" "}
          <strong>Default</strong> for the one that should be preselected.
        </Example>

        <Example title="Change a printer's defaults">
          Open it under <strong>Printers</strong>. Two-sided, colour and whether it is visible on
          the network are settings on the printer, so changing them reaches everyone at once.
        </Example>

        <Where>Printers, once a server carries the print-server role.</Where>
      </Quickstart>

        <Example title="Find a printer on the network">
          <strong>New printer</strong> → pick the server → <strong>Scan</strong>. The server asks
          CUPS and asks avahi, so a driverless printer announcing itself over DNS-SD turns up as
          the address to print to and the name it announces. Typing an address still works.
        </Example>

      <Details>
        <Section title="Drivers">
          <p>
            A PPD is the Linux equivalent of a print driver. Anything made in the last decade speaks
            IPP Everywhere and CUPS configures it without one, which is why{" "}
            <strong>Driverless</strong> is the default. Where a PPD is uploaded it is stored in the
            control plane, so a print server rebuilt from scratch gets its printers back without
            anyone hunting for driver files again.
          </p>
          <Note>
            An upload is checked for a <C>*PPD-Adobe</C> line before it is stored. A file that is
            not a PPD is refused here rather than failing on the server, where the reason would be
            harder to see.
          </Note>
        </Section>

        <Section title="Addresses">
          <Reference
            headers={["Kind", "Looks like"]}
            rows={[
              ["Network printer, modern", <C key="a">ipp://10.10.0.31/ipp/print</C>],
              [
                "Network printer, encrypted",
                <C key="b">ipps://printer.example.internal/ipp/print</C>,
              ],
              ["Raw JetDirect port", <C key="c">socket://10.10.0.31:9100</C>],
              ["Line printer daemon", <C key="d">lpd://10.10.0.31/queue</C>],
              ["Directly attached", <C key="e">usb://HP/LaserJet</C>],
            ]}
          />
        </Section>

        <Section title="A test page">
          <p>
            <strong>Test page</strong> on a printer&rsquo;s row queues CUPS&rsquo;s own test page
            for the print server. It runs there, not here: the server holds the queue, so a page
            that comes out proves the half of the path the console cannot see — server to device.
          </p>
          <Reference
            headers={["Answer", "Means"]}
            rows={[
              ["Sent", "The queue accepted the job. A page should come out of the device."],
              [
                "Could not print it",
                "The queue refused the job — not accepting jobs, or the device is unreachable. What the queue said is shown underneath.",
              ],
              [
                "Waiting for the server to pick it up",
                "The task is queued and the server has not collected it yet. With push on it is seconds; otherwise the polling interval.",
              ],
            ]}
          />
        </Section>

        <Section title="Handing a printer out in a policy">
          <p>
            The <strong>Printer</strong> field of a policy entry is the <em>queue</em> on the print
            server — <C>odm-prt-01</C> — not the printer&rsquo;s own address. The agent points CUPS
            at <C>ipp://&lt;print server&gt;/printers/&lt;queue&gt;</C>, and the server holds the
            driver and the device address. <strong>Select…</strong> lists the queues that exist
            across every print server and fills in the server with the choice.
          </p>
          <Note>
            A device address in that field is refused: the queue name is part of the printer&rsquo;s
            address on the client, so it has to be a name, not a URL.
          </Note>
        </Section>

        <Section title="On the client">
          <p>
            The agent points CUPS at the print server and adds each printer the policy names, so a
            person sees the printers meant for them and nothing else. A printer added on the server
            later is browsable without waiting for a policy refresh.
          </p>
        </Section>

        <Section title="If a printer stays in applying">
          <Reference
            headers={["Check", "How"]}
            rows={[
              [
                "Has the server's agent checked in?",
                "Directory → the machine → Machine → Last reported.",
              ],
              [
                "Does the server carry the print-server role?",
                "Server Roles → Print server. Without CUPS there is no queue to create.",
              ],
              [
                "What did the agent say?",
                <>
                  On the server: <C key="f">journalctl -u odm-agent</C>, or{" "}
                  <C key="g">odm-agent apply --force</C> to make it try now.
                </>,
              ],
            ]}
          />
        </Section>
      </Details>
    </>
  );
}
