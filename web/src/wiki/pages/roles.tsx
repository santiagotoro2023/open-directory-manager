import { C, Details, Example, Note, Quickstart, Reference, Section, Steps, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "server-roles",
  title: "Server roles",
  section: "Administration",
  summary: "What is installed where, and how to add DHCP, file-server and certificate-authority roles.",
  keywords: ["role", "install", "dhcp", "file server", "ca", "extend", "plugin", "node"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          A fresh install runs the core role: the directory, Group Policy and DNS. Everything
          else is added afterwards without redeploying anything.
        </p>

        <Example title="Add a role">
          <Steps>
            <li>
              <strong>Server Roles</strong> → click the role → <strong>Install on a server</strong>.
            </li>
            <li>
              <strong>Select…</strong> and choose the server. Any joined machine can carry a
              role, not only a controller.
            </li>
            <li>Fill in the role&rsquo;s settings and install.</li>
            <li>
              The role&rsquo;s row lists every server it runs on and the state of each. It moves
              from <C>installing</C> to <C>active</C>.
            </li>
            <li>Add any settings the installer prints to the secrets file, then restart the control plane.</li>
          </Steps>
        </Example>

        <Where>Server Roles.</Where>
      </Quickstart>

      <Details>
        <Section title="Roles">
          <Reference
            headers={["Role", "Provides", "Needs"]}
            rows={[
              [
                "Core",
                "The directory, Kerberos, SYSVOL and the integrated DNS zones. Always present.",
                "—",
              ],
              [
                "DHCP",
                "A failover pair with dynamic DNS into the domain's own zones.",
                "Failover role, this node's and the peer's URLs, the realm, a DNS server.",
              ],
              [
                "File server",
                "Kerberos-authenticated SMB shares for drive maps.",
                "Share name, share path, optionally a group allowed to use it.",
              ],
              [
                "Certificate authority",
                "An internal CA that issues certificates and publishes its root through policy.",
                "Optionally a CA directory.",
              ],
              [
                "Client enrolment (PXE)",
                "Unattended Debian installation over the network, joining the domain on first boot.",
                "Interface, domain, a multi-use enrolment token, optionally the Debian suite.",
              ],
            ]}
          />
        </Section>

        <Section title="Installation states">
          <Reference
            headers={["State", "Means"]}
            rows={[
              ["installing", "The installer is running. The list refreshes while it does."],
              ["active", "The installer finished successfully."],
              ["failed", "The installer failed. The reason is shown on the row."],
              ["removed", "Deregistered from ODM. The packages are still running on the node."],
            ]}
          />
          <Note>
            Installing a role means package installation and service restarts, so it takes minutes.
            The request returns immediately and the state is polled.
          </Note>
        </Section>

        <Section title="Client enrolment (PXE)">
          <p>
            The role serves network boot as a proxy DHCP server, so address assignment stays with
            the DHCP role or whatever already provides it. Machines installed this way run the
            join client on first boot with the enrolment token given at install time.
          </p>
          <Reference
            headers={["Path", "Holds"]}
            rows={[
              [<C key="1">/srv/tftp</C>, "The Debian netboot images."],
              [<C key="2">/srv/odm-preseed/odm.cfg</C>, "The unattended installation answers."],
              [<C key="3">/srv/odm-preseed/odm-client-install</C>, "The join binary the installed machine fetches."],
            ]}
          />
          <Note>
            Create a multi-use enrolment token under <strong>Directory</strong> first, place the
            join binary where the preseed expects it, and set a real local administrator password
            hash in the preseed before using this outside a lab.
          </Note>
        </Section>

        <Section title="Deregistering">
          <p>
            Deregistering removes ODM&rsquo;s record of the role. It does not uninstall packages or
            stop services on the node; do that on the node itself.
          </p>
        </Section>

        <Section title="Prerequisites on the control plane host">
          <p>
            Role installation needs root, which the control plane does not have. The deployment
            installs one privileged helper and a rule granting the service user exactly that
            command.
          </p>
          <Reference
            headers={["File", "Purpose"]}
            rows={[
              [<C key="1">/opt/odm/bin/odm-role-install</C>, "Maps a role name to its installer."],
              [<C key="2">/opt/odm/deploy/install-*-role.sh</C>, "The installers themselves."],
              [<C key="3">/etc/sudoers.d/odm-roles</C>, "Grants the service user those commands and nothing else."],
            ]}
          />
        </Section>

        <Section title="Adding a new role">
          <p>A role is three things.</p>
          <Steps>
            <li>
              A descriptor in the control plane naming the role, its arguments, the packages it
              installs and any settings it produces.
            </li>
            <li>
              An installer script under <C>deploy/</C>, and a case for it in the privileged helper.
            </li>
            <li>A console section that appears once the role reports active.</li>
          </Steps>
          <Note>
            Only arguments a descriptor declares are ever passed to an installer, and each is
            pattern-checked first.
          </Note>
        </Section>
      </Details>
    </>
  );
}
