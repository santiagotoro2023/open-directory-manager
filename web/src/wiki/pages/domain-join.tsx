import { C, Code, Details, Example, Note, Quickstart, Reference, Section, Steps, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "domain-join",
  title: "Joining machines",
  section: "Clients",
  summary: "Joining a Debian machine to the domain from the command line or the desktop app.",
  keywords: ["join", "odm-client-install", "enroll", "sssd", "krb5", "keytab", "client"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          Joining a machine creates its account in the directory, installs its Kerberos keytab,
          configures name resolution and authentication, and installs the policy agent. Two front
          ends do the same work: a command for servers and scripted provisioning, and a desktop
          application for workstations.
        </p>

        <Example title="Join from the command line">
          <Code>{`sudo odm-client-install \\
  --domain corp.example.internal \\
  --admin-user Administrator`}</Code>
          Prompts for anything not given. Add <C>--unattended</C> with{" "}
          <C>--otp</C> for scripted provisioning.
        </Example>

        <Example title="Join from the desktop">
          Launch <strong>Join Domain</strong>, enter the domain and a credential, and follow the
          progress view.
        </Example>

        <Example title="Confirm it worked">
          <Code>{`klist -k /etc/krb5.keytab
id someone@corp.example.internal
systemctl status odm-agent`}</Code>
        </Example>

        <Where>The host appears under Directory once the join finishes.</Where>
      </Quickstart>

      <Details>
        <Section title="Before joining">
          <Reference
            headers={["Requirement", "Why"]}
            rows={[
              ["Debian 12 or 13", "The supported client platforms."],
              ["The machine's final host name", "It becomes the account name and the certificate subject."],
              ["The domain's DNS as resolver", "Service records locate the domain controllers."],
              ["Clock within five minutes", "Kerberos rejects tickets outside its tolerance."],
              ["A join credential", "A domain administrator, or a one-time password."],
            ]}
          />
        </Section>

        <Section title="Options">
          <Reference
            headers={["Option", "Meaning"]}
            rows={[
              [<C key="1">--domain</C>, "The domain to join. Required."],
              [<C key="2">--server</C>, "A specific controller. Discovered from DNS when omitted."],
              [<C key="3">--admin-user</C>, "Join as this account; the password is prompted for."],
              [<C key="4">--otp</C>, "Join with a one-time password instead of a credential."],
              [<C key="5">--ou</C>, "Create the host account in this organizational unit."],
              [<C key="6">--hostname</C>, "Override the host name used for the account."],
              [<C key="7">--api-url</C>, "The control plane. Discovered from the domain when omitted."],
              [<C key="8">--no-agent</C>, "Join without installing the policy agent."],
              [<C key="9">--unattended</C>, "Never prompt. Fails rather than asking."],
            ]}
          />
        </Section>

        <Section title="What a join changes">
          <Reference
            headers={["Step", "Result"]}
            rows={[
              ["Discovery", "Locates controllers through the domain's service records."],
              ["Kerberos", <>Writes <C key="a">/etc/krb5.conf</C> for the realm.</>],
              ["Join", "Creates or takes over the host account and writes /etc/krb5.keytab."],
              ["Identity", <>Writes <C key="b">/etc/sssd/sssd.conf</C> so domain users resolve and can log in.</>],
              ["Name service", "Adds sss to passwd, group and shadow, and enables home-directory creation."],
              ["Agent", "Installs odm-agent, writes its configuration and enables the service."],
              ["First apply", "Runs the agent once so the machine arrives with its policy."],
            ]}
          />
          <Note>
            Both front ends produce the same configuration. The desktop application is a view over
            the same join library the command uses.
          </Note>
        </Section>

        <Section title="One-time passwords">
          <p>
            A one-time password lets a machine join without a domain administrator credential on
            the client. It is single-use and time-limited.
          </p>
        </Section>

        <Section title="Verifying">
          <Code>{`klist -k /etc/krb5.keytab          # the machine's own principals
id someone@corp.example.internal   # domain identity resolves
getent group 'domain users'        # group resolution
sudo odm-agent apply --force       # policy applies
systemctl status odm-agent`}</Code>
          <p>
            In the console, the host appears under <strong>Directory</strong> and its{" "}
            <strong>Policy</strong> dialog shows a report once the agent has run.
          </p>
        </Section>

        <Section title="Leaving">
          <Steps>
            <li>Stop and disable the agent service.</li>
            <li>Remove the host account from the directory in the console.</li>
            <li>
              Remove <C>/etc/krb5.keytab</C>, the SSSD configuration and{" "}
              <C>/etc/odm</C>.
            </li>
          </Steps>
          <Note>
            Deleting the host account puts it in the recycle bin. Restoring it issues a new
            security identifier, so a machine restored this way must be re-joined.
          </Note>
        </Section>
      </Details>
    </>
  );
}
