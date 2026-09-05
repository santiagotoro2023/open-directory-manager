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
  id: "domain-join",
  title: "Joining machines",
  section: "Clients",
  summary: "Joining a Debian machine to the domain with odm-client-install.",
  keywords: ["join", "odm-client-install", "enroll", "sssd", "krb5", "keytab", "client"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <Example title="Install the package and run the join">
          <Code>{`sudo apt update
sudo apt install ./odm-client_<version>_amd64.deb
sudo odm-client-install \
  --domain corp.example.internal \
  --admin-user Administrator`}</Code>
          One file, one command, the same on a workstation as on a server. Anything omitted is
          prompted for; <C>--unattended</C> with <C>--otp</C> is the scripted form. The refresh
          matters on a machine installed from an older image: the package pulls in Samba and
          SSSD, and a stale index asks for files the mirror has already pruned.
        </Example>

        <p>
          Joining a machine creates its account in the directory, installs its Kerberos keytab,
          configures name resolution and authentication, and installs the policy agent. There is
          no graphical installer: a desktop user opens a terminal and runs the same one line a
          scripted install does, so what a person sees is what an unattended run does.
        </p>

        <Example title="Confirm it worked">
          <Code>{`sudo odm-agent check
id someone@corp.example.internal`}</Code>
          <C>check</C> walks every step from configuration to check-in and names the first that
          fails, which is the answer to a machine that has joined and reports nothing.
        </Example>

        <Example title="Join without a terminal">
          <C>ODM_ADMIN_PASSWORD</C> in the environment, or <strong>--password-file</strong>,
          supplies the credential, and standard input is read when it is not a terminal — so a
          provisioning script can run the same command.
        </Example>

        <Where>The computer appears under Directory once the join finishes.</Where>
      </Quickstart>

      <Details>
        <Section title="Leaving the domain">
          <p>
            Two different rights are involved, and they are not interchangeable. Removing the
            computer account from the directory needs a domain credential that may do so.
            Disconnecting the machine needs root on the machine — and root can always do it, because
            root owns the machine.
          </p>
          <Code>{`# both halves: the account goes too
sudo odm-client-install --leave --domain corp.example.internal \\
    --admin-user Administrator

# local half only; the account stays for an administrator to delete
sudo odm-client-install --leave --domain corp.example.internal --force`}</Code>
          <Reference
            headers={["Action", "Needs"]}
            rows={[
              ["Join", "root on the machine, and a domain credential or an enrolment token"],
              ["Leave, account and all", "root on the machine, and a domain credential"],
              ["Leave locally (--force)", "root on the machine"],
              [
                "Stop or remove the agent",
                "root on the machine: it is a system service and a system package",
              ],
            ]}
          />
          <Note>
            An ordinary user can do none of these. Everything the agent writes is root-owned, its
            keytab is readable only by root, and it runs as a systemd unit — a user without sudo can
            neither stop it nor uninstall it.
          </Note>
        </Section>

        <Section title="Before joining">
          <Reference
            headers={["Requirement", "Why"]}
            rows={[
              ["Debian 12 or 13", "The supported client platforms."],
              [
                "The machine's final host name",
                "It becomes the account name and the certificate subject.",
              ],
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
              [
                <C key="6">--hostname</C>,
                "Name this machine takes in the domain. Its own name when omitted.",
              ],
              [
                <C key="7">--api-url</C>,
                "The control plane. Discovered from the domain when omitted.",
              ],
              [
                <C key="13">--ca-cert</C>,
                "The console's certificate. Read from the domain when omitted, so this is only for a machine that cannot read SYSVOL yet — a token join, or a network where the controller is reachable over HTTPS but not SMB.",
              ],
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

        <Section title="How the console's certificate reaches the machine">
          <p>
            A machine has to verify the console before it will talk to it, and until the domain has
            a certificate authority of its own the console&rsquo;s certificate is self-signed — so
            nothing in the system trust store vouches for it. The domain publishes it in SYSVOL and
            the join reads it from there, as the machine account it has just created.
          </p>
          <Reference
            headers={["Step", "Where"]}
            rows={[
              [
                "Published",
                <>
                  <C key="p1">&lt;sysvol&gt;/&lt;domain&gt;/odm/api-ca.pem</C> on the controller,
                  written by setup and again whenever the certificate is replaced.
                </>,
              ],
              [
                "Fetched",
                <>
                  <C key="p2">smbclient --machine-pass --use-kerberos=required</C> during the join,
                  and by the agent itself whenever verification starts failing.
                </>,
              ],
              [
                "Stored",
                <>
                  <C key="p3">/etc/odm/tls/api-ca.pem</C>, named by{" "}
                  <C key="p4">ca_cert</C> in the agent&rsquo;s configuration.
                </>,
              ],
            ]}
          />
          <Note>
            What makes reading it safe is that the transfer is Kerberos-authenticated with
            mandatory signing: the controller proves itself with the KDC, not with the certificate
            being fetched. Nothing is taken on trust because it happened to answer.
          </Note>
          <p>
            A token join is the exception. It has no Kerberos identity yet — it is exchanging a
            token for one — so it cannot read SYSVOL and needs <C>--ca-cert</C>. Client enrolment
            stages the certificate on the boot server for exactly this reason.
          </p>
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
              [
                "Kerberos",
                <>
                  Writes <C key="a">/etc/krb5.conf</C> for the realm.
                </>,
              ],
              ["Join", "Creates or takes over the computer account and writes /etc/krb5.keytab."],
              [
                "Identity",
                <>
                  Writes <C key="b">/etc/sssd/sssd.conf</C> so domain users resolve and can log in.
                </>,
              ],
              [
                "Name service",
                "Adds sss to passwd, group and shadow, and enables home-directory creation.",
              ],
              [
                "Services",
                <>
                  Enables and restarts <C key="s">sssd</C> so the new configuration takes effect.
                </>,
              ],
              ["Agent", "Installs odm-agent, writes its configuration and enables the service."],
              ["First apply", "Runs the agent once so the machine arrives with its policy."],
            ]}
          />
          <Note>
            A machine holds its Kerberos identity under its fully-qualified name, so a machine
            called <C>ws01</C> joining <C>corp.example.internal</C> becomes{" "}
            <C>ws01.corp.example.internal</C>. Services already running keep the old name until they
            restart; reboot after a join that renamed the machine. <C>--keep-hostname</C> stops the
            join instead of renaming.
          </Note>
        </Section>

        <Section title="Enrolment tokens">
          <p>
            A token lets a machine enrol without a domain administrator credential ever being typed
            on it.
          </p>
          <Steps>
            <li>
              In the console: <strong>Directory</strong> → select the container the computer
              accounts should land in → <strong>Enrolment tokens</strong>.
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
            keytab, and nothing else. Redemption is throttled per source address, and every attempt
            — successful or refused — is recorded in the audit log. A token can be revoked at any
            time from the same dialog.
          </p>
          <Note>
            Token enrolment needs the control plane on a domain controller. Where it is not, join
            with <C>--admin-user</C>.
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
              Remove <C>/etc/krb5.keytab</C>, the SSSD configuration and <C>/etc/odm</C>.
            </li>
          </Steps>
          <Note>
            Deleting the computer account puts it in the recycle bin. Restoring it issues a new
            security identifier, so a machine restored this way must be re-joined.
          </Note>
        </Section>
        <Section title="What the package installs">
          <p>
            The client package brings what the appliers need, so a joined machine works without
            anything else being installed by hand: <C>sssd-ad</C>, <C>krb5-user</C> and{" "}
            <C>adcli</C> for the join itself, <C>cifs-utils</C> and <C>keyutils</C> for drive maps
            and profile disks, <C>smbclient</C> to read the console&rsquo;s certificate out of
            SYSVOL during the join, and <C>libpam-oath</C> with <C>qrencode</C> for the second
            factor.
          </p>
          <Note>
            A machine joined before a version that added one of these does not get it from a
            policy refresh. <C>apt install --reinstall odm-client</C> brings the machine up to
            what the current package depends on.
          </Note>
        </Section>

      </Details>
    </>
  );
}
