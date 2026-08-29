import { C, Details, Example, Note, Quickstart, Reference, Section, Steps, Where } from "../components";
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
          A printer is defined once on a print server. Clients get it from that server rather
          than driving the hardware themselves, so nothing is installed on a workstation: the
          server holds the queue and the driver.
        </p>

        <Example title="Publish a printer">
          <Steps>
            <li>
              <strong>Server Roles</strong> → <strong>Print server</strong> →{" "}
              <strong>Install on a server</strong>, if that machine does not carry the role yet.
            </li>
            <li>
              <strong>Printers</strong> → <strong>New printer</strong> → pick the server, name
              it, and give the address the server reaches the printer at.
            </li>
            <li>
              Leave <strong>Driverless</strong> selected unless the printer is old enough to
              need a PPD.
            </li>
            <li>
              <strong>Create</strong>. The state moves from <C>applying</C> to <C>active</C>{" "}
              when the server&rsquo;s agent has configured it.
            </li>
          </Steps>
        </Example>

        <Example title="Give people a printer">
          <strong>Group Policy</strong> → the policy object → <strong>Settings</strong> →{" "}
          <strong>User</strong> → <strong>Printers</strong> → <strong>Add</strong>. Name the
          printer and its server, choose the group with <strong>Select…</strong>, and tick{" "}
          <strong>Default</strong> for the one that should be preselected.
        </Example>

        <Example title="Change a printer's defaults">
          Open it under <strong>Printers</strong>. Two-sided, colour and whether it is visible
          on the network are settings on the printer, so changing them reaches everyone at once.
        </Example>

        <Where>Printers, once a server carries the print-server role.</Where>
      </Quickstart>

      <Details>
        <Section title="Drivers">
          <p>
            A PPD is the Linux equivalent of a print driver. Anything made in the last decade
            speaks IPP Everywhere and CUPS configures it without one, which is why{" "}
            <strong>Driverless</strong> is the default. Where a PPD is uploaded it is stored in
            the control plane, so a print server rebuilt from scratch gets its printers back
            without anyone hunting for driver files again.
          </p>
          <Note>
            An upload is checked for a <C>*PPD-Adobe</C> line before it is stored. A file that
            is not a PPD is refused here rather than failing on the server, where the reason
            would be harder to see.
          </Note>
        </Section>

        <Section title="Addresses">
          <Reference
            headers={["Kind", "Looks like"]}
            rows={[
              ["Network printer, modern", <C key="a">ipp://10.10.0.31/ipp/print</C>],
              ["Network printer, encrypted", <C key="b">ipps://printer.example.internal/ipp/print</C>],
              ["Raw JetDirect port", <C key="c">socket://10.10.0.31:9100</C>],
              ["Line printer daemon", <C key="d">lpd://10.10.0.31/queue</C>],
              ["Directly attached", <C key="e">usb://HP/LaserJet</C>],
            ]}
          />
        </Section>

        <Section title="On the client">
          <p>
            The agent points CUPS at the print server and adds each printer the policy names,
            so a person sees the printers meant for them and nothing else. A printer added on
            the server later is browsable without waiting for a policy refresh.
          </p>
        </Section>

        <Section title="If a printer stays in applying">
          <Reference
            headers={["Check", "How"]}
            rows={[
              ["Has the server's agent checked in?", "Servers → the machine → Agent last reported."],
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
