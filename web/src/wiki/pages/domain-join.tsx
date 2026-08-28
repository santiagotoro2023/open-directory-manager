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

        <Where>The computer appears under Directory once the join finishes.</Where>
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
              [<C key="4">--otp</C>, "Enrol with a one-time token instead of a credential."],
              [<C key="5">--ou</C>, "Create the computer account in this organizational unit."],
              [<C key="6">--hostname</C>, "Name this machine takes in the domain. Its own name when omitted."],
              [<C key="7">--api-url</C>, "The control plane. Discovered from the domain when omitted."],
              [<C key="8">--no-agent</C>, "Join without installing the policy agent."],
              [<C key="9">--unattended</C>, "Never prompt. Fails rather than asking."],
              [<C key="10">--password-file</C>, "Read the credential's password from a file."],
              [<C key="11">--dry-run</C>, "Report what would happen and change nothing."],
              [
                <C key="12">--keep-hostname</C>,
                "Fail rather than renaming this machine to its domain name.",
              ],
            ]}
          />
        </Section>

        <Section title="What a join changes">
          <Reference
            headers={["Step", "Result"]}
            rows={[
              [
                "Naming",
                <>
                  Renames this machine to its fully-qualified domain name and points{" "}
                  <C key="h">/etc/hosts</C> at it.
                </>,
              ],
              ["Discovery", "Locates controllers through the domain's service records."],
              ["Kerberos", <>Writes <C key="a">/etc/krb5.conf</C> for the realm.</>],
              ["Join", "Creates or takes over the computer account and writes /etc/krb5.keytab."],
              ["Identity", <>Writes <C key="b">/etc/sssd/sssd.conf</C> so domain users resolve and can log in.</>],
              ["Name service", "Adds sss to passwd, group and shadow, and enables home-directory creation."],
              ["Services", <>Enables and restarts <C key="s">sssd</C> so the new configuration takes effect.</>],
              ["Agent", "Installs odm-agent, writes its configuration and enables the service."],
              ["First apply", "Runs the agent once so the machine arrives with its policy."],
            ]}
          />
          <Note>
            A machine holds its Kerberos identity under its fully-qualified name, so a machine
            called <C>ws01</C> joining <C>corp.example.internal</C> becomes{" "}
            <C>ws01.corp.example.internal</C>. Services already running keep the old name until
            they restart; reboot after a join that renamed the machine.{" "}
            <C>--keep-hostname</C> stops the join instead of renaming.
          </Note>
          <Note>
            Both front ends produce the same configuration. The desktop application is a view over
            the same join library the command uses, and a test asserts that two runs of the same
            options produce identical files.
          </Note>
        </Section>

        <Section title="Enrolment tokens">
          <p>
            A token lets a machine enrol without a domain administrator credential ever being
            typed on it.
          </p>
          <Steps>
            <li>
              In the console: <strong>Directory</strong> → select the container the computer accounts
              should land in → <strong>Enrolment tokens</strong>.
            </li>
            <li>
              Set how many machines may use it and how long it lives, then{" "}
              <strong>Create token</strong>. The command to run on the client is shown once.
            </li>
            <li>
              On the client: <C>odm-client-install --domain … --otp …</C>.
            </li>
          </Steps>
          <p>
            Redeeming a token creates the computer account and returns that machine&rsquo;s own
            keytab, and nothing else. Redemption is throttled per source address, and every
            attempt — successful or refused — is recorded in the audit log. A token can be revoked
            at any time from the same dialog.
          </p>
          <Note>
            Token enrolment needs the control plane on a domain controller. Where it is not,
            join with <C>--admin-user</C>.
          </Note>
        </Section>

        <Section title="Verifying">
          <Code>{`klist -k /etc/krb5.keytab          # the machine's own principals
id someone@corp.example.internal   # domain identity resolves
getent group 'domain users'        # group resolution
sudo odm-agent apply --force       # policy applies
systemctl status odm-agent`}</Code>
          <p>
            In the console, the computer appears under <strong>Directory</strong> and its{" "}
            <strong>Policy</strong> dialog shows a report once the agent has run.
          </p>
        </Section>

        <Section title="Leaving">
          <Steps>
            <li>Stop and disable the agent service.</li>
            <li>Remove the computer account from the directory in the console.</li>
            <li>
              Remove <C>/etc/krb5.keytab</C>, the SSSD configuration and{" "}
              <C>/etc/odm</C>.
            </li>
          </Steps>
          <Note>
            Deleting the computer account puts it in the recycle bin. Restoring it issues a new
            security identifier, so a machine restored this way must be re-joined.
          </Note>
        </Section>
      </Details>
    </>
  );
}
