import { C, Details, Example, Note, Quickstart, Reference, Section, Steps, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "network-access",
  title: "Network access",
  section: "Administration",
  summary: "RADIUS: who gets onto which network, wired, wireless or over the VPN.",
  keywords: ["radius", "802.1x", "wifi", "vlan", "freeradius", "nas", "eap", "network"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          A device asks — a switch, an access point, a VPN server — and a rule decides, against
          the directory&rsquo;s own groups. There is no second copy of who is in what.
        </p>

        <Example title="Let a group onto the wireless">
          <Steps>
            <li>
              <strong>Server Roles</strong> → <strong>Network access (RADIUS)</strong> →{" "}
              <strong>Install on a server</strong>.
            </li>
            <li>
              <strong>Network Access</strong> → <strong>Devices</strong> →{" "}
              <strong>Add a device</strong> → the access point&rsquo;s address, and a network
              name such as <C>corp-wifi</C>. Copy the shared secret into the device: it is shown
              once.
            </li>
            <li>
              <strong>Rules</strong> → <strong>New rule</strong> → choose the group, tick{" "}
              <C>corp-wifi</C>, leave it on <strong>Allow</strong>.
            </li>
          </Steps>
        </Example>

        <Example title="Put a group on its own VLAN">
          The same rule, with a <strong>VLAN</strong>. The server returns it and the switch puts
          the session there, which is most of why 802.1X is worth doing.
        </Example>

        <Example title="Let machines on, but not the people using them">
          Set <strong>Applies to</strong> to <strong>Machines</strong>. A machine authenticates
          as itself, never as a person, and the rule matches on that.
        </Example>

        <Where>Network Access, once a server carries the RADIUS role.</Where>
      </Quickstart>

      <Details>
        <Section title="How a decision is made">
          <p>
            Rules are checked in order, denials first, and a request that matches nothing is
            refused. That last part is stated in the configuration rather than left to a default
            that could change with an upgrade. <strong>As evaluated</strong> shows exactly what
            the server reads — an access decision you cannot inspect is one you have to guess at.
          </p>
          <Reference
            headers={["Field", "What it does"]}
            rows={[
              ["Group", "Membership comes from the directory through winbind."],
              [
                "Applies to",
                "People, machines, or either. A machine authenticates as host/<name> or NAME$.",
              ],
              [
                "Which networks",
                "The network names your devices send. None ticked means every network this server serves.",
              ],
              ["VLAN", "Returned to the device, which places the session in it."],
              ["Order", "Lower is checked first. Denials are always checked before allows."],
            ]}
          />
        </Section>

        <Section title="Passwords or certificates">
          <Reference
            headers={["Method", "What it needs"]}
            rows={[
              [
                "PAP / MSCHAPv2",
                "Nothing extra. The password is checked against the directory through winbind; FreeRADIUS never sees it in the clear.",
              ],
              [
                "EAP-TLS",
                "A certificate on each machine. Certificates → and the certificate policy setting issue and renew them automatically.",
              ],
            ]}
          />
          <Note>
            EAP-TLS is the one worth aiming at: a machine that has a certificate needs no
            password on the network at all, and a machine that has left the domain stops having
            one.
          </Note>
        </Section>

        <Section title="Shared secrets">
          <p>
            A device&rsquo;s shared secret is the only thing proving a request came from it. ODM
            generates one rather than letting anyone choose it, shows it once, and never lists it
            again. If it is lost, remove the device and add it back.
          </p>
        </Section>

        <Section title="If nothing can get on">
          <Reference
            headers={["Check", "How"]}
            rows={[
              ["Is there a rule at all?", "No rules means nothing is allowed. That is deliberate."],
              [
                "Does the device match one?",
                "Its address has to fall inside what was entered, and its network name has to match what the rule ticks.",
              ],
              [
                "Did the configuration apply?",
                <>
                  Servers → the machine → its queued work. The agent checks the configuration
                  with <C key="a">freeradius -CX</C> before restarting, so a bad rule fails
                  visibly rather than taking the service down.
                </>,
              ],
              [
                "Is the port open?",
                "1812/udp for authentication, 1813/udp for accounting. Nothing here opens them.",
              ],
            ]}
          />
        </Section>
      </Details>
    </>
  );
}
