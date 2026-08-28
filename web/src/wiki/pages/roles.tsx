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
          A fresh install runs the core role: Active Directory, Group Policy and DNS. Everything
          else is added afterwards without redeploying anything.
        </p>

        <Example title="Add a role">
          <Steps>
            <li>
              <strong>Server Roles</strong> → find it under <strong>Available</strong> →{" "}
              <strong>Install</strong>.
            </li>
            <li>Give the node&rsquo;s fully-qualified name and the role&rsquo;s settings.</li>
            <li>
              Watch the state under <strong>Installed</strong>. It moves from{" "}
              <C>installing</C> to <C>active</C>.
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
