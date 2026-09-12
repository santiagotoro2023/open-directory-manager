import { C, Details, Example, Note, Quickstart, Reference, Section, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "passwords",
  title: "Passwords",
  section: "Managing the domain",
  summary: "Who may reset one, the local machine's own rules, and a second factor for the console.",
  keywords: ["password", "local password policy", "second factor", "reset"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          The domain&rsquo;s own password rules — length, complexity, lockout, expiry — are set the
          way every AD-compatible tool sets them: with <C>samba-tool domain passwordsettings</C>{" "}
          directly. Samba enforces whatever that says on every change however it is made, through
          this console, from a client, or with samba-tool itself, so there is one rule rather than
          one rule and a copy of it in ODM&rsquo;s own database.
        </p>

        <Example title="Set what a local password has to be">
          <strong>Group Policy</strong> → a policy object → <strong>Computer</strong> →{" "}
          <strong>Local password policy</strong>. Only accounts that live on the machine itself —
          domain accounts keep the domain&rsquo;s own rules.
        </Example>

        <Example title="Reset somebody else's">
          <strong>Directory</strong> → the user → <strong>Reset password</strong>. Needs{" "}
          <C>user.password.reset</C>, which helpdesk holds.
        </Example>

        <Where>Group Policy → Computer → Local password policy for the machine's own rules.</Where>
      </Quickstart>

      <Details>
        <Section title="The domain's own policy">
          <p>
            Not a policy-object setting: Active Directory holds these rules on the domain itself,
            and every AD-compatible tool — this console included, if it wrote one — would be a
            second place the same rule could drift out of step with the one the directory actually
            enforces. Set it directly:
          </p>
          <Reference
            headers={["To", "Run"]}
            rows={[
              [
                "See the current policy",
                <C key="a">samba-tool domain passwordsettings show</C>,
              ],
              [
                "Change it",
                <C key="b">samba-tool domain passwordsettings set --min-pwd-length=12 ...</C>,
              ],
              [
                "A fine-grained policy for particular accounts",
                <C key="c">samba-tool domain passwordsettings pso-create ...</C>,
              ],
            ]}
          />
        </Section>

        <Section title="A second factor">
          <p>
            <strong>Second factor</strong> in the top bar enrols a time-based code, scanned from a
            QR code into an authenticator app or a password manager. It protects this console only —
            signing in to a workstation is unaffected, unless a policy object&rsquo;s own{" "}
            <strong>Second factor</strong> setting asks for one there too.
          </p>
          <Reference
            headers={["Detail", "How it works"]}
            rows={[
              [
                "Enrolment",
                "Two steps: a secret is issued, and it only becomes required once a code from the device has been accepted. Nobody locks themselves out with a QR code they never scanned.",
              ],
              [
                "The QR code",
                "Drawn in the browser. It contains the secret, so sending it to a rendering service would be sending the secret to a third party.",
              ],
              [
                "Recovery codes",
                "Ten, shown once, each usable once. Without them a lost phone is a locked-out administrator and somebody has to edit the database.",
              ],
              [
                "Replay",
                "A code is valid for thirty seconds; the last step accepted is remembered, so anyone who saw it cannot use it again inside that window.",
              ],
              [
                "Removing it",
                "Needs a current code. Otherwise a stolen session could take the second factor off and keep the account.",
              ],
            ]}
          />
        </Section>

        <Note>
          Recovering a <em>forgotten</em> password needs a second factor to prove who is asking —
          an enrolled device or a verified address — and ODM has no such factor yet for a forgotten
          console password. Until it does, that is a helpdesk reset, which is at least a human
          deciding.
        </Note>

        <Section title="Where each right sits">
          <Reference
            headers={["Action", "Needs"]}
            rows={[
              ["See the domain's password policy", "Root, on a domain controller."],
              ["Change it", "Domain Admins, the same as samba-tool anywhere else."],
              ["Reset somebody else's password", <C key="a">user.password.reset</C>],
              ["Set the local password policy", <C key="b">gpo.write</C>],
            ]}
          />
        </Section>
      </Details>
    </>
  );
}
