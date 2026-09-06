import { C, Details, Example, Note, Quickstart, Reference, Section, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "passwords",
  title: "Passwords",
  section: "Managing the domain",
  summary: "What a password has to be, who may reset one, and letting people change their own.",
  keywords: ["password", "policy", "complexity", "lockout", "expiry", "self service", "reset"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          The password policy lives in the directory, not in ODM&rsquo;s database. Samba enforces it
          on every password change however it is made — through this console, from a client, or with
          samba-tool — so there is one rule rather than one rule and a copy of it.
        </p>

        <Example title="Change what a password has to be">
          <strong>Group Policy</strong> → a policy object linked at the domain root →{" "}
          <strong>Computer</strong> → <strong>Password policy</strong>. It applies to the next
          password set, not to the ones already in use.
        </Example>

        <Example title="Require more of some accounts than others">
          The same setting, in an object of its own, naming the groups it is for. That is a
          fine-grained password policy, and it overrides the domain&rsquo;s for those people.
        </Example>

        <Example title="Let people change their own">
          <strong>Group Policy</strong> → <strong>User</strong> →{" "}
          <strong>Self-service password</strong>. Not configured anywhere means yes; a policy object
          is how it is taken away.
        </Example>

        <Example title="Change your own">
          <strong>Change password</strong> in the top bar, next to Sign out. It appears when policy
          allows it for your account.
        </Example>

        <Example title="Reset somebody else's">
          <strong>Directory</strong> → the user → <strong>Reset password</strong>. Needs{" "}
          <C>user.password.reset</C>, which helpdesk holds.
        </Example>

        <Where>
          Group Policy → Computer → Password policy for the rule; the top bar for your own.
        </Where>
      </Quickstart>

      <Details>
        <Section title="Where the rule is set">
          <p>
            It is a policy-object setting like every other, with one difference worth knowing:
            no machine applies it. The directory enforces password rules itself, on every change,
            wherever it is made — so the console writes the setting to the domain when the object
            or its links change, and an agent never sees it.
          </p>
          <Note>
            With no group named it is the domain&rsquo;s own policy, and the object has to be
            linked at the domain root: that is where Active Directory holds this, and an account
            policy linked to an organizational unit reaches nothing. Naming groups makes it a
            fine-grained policy for their members instead, which applies wherever the object is
            linked, because it is the membership that decides who it is for.
          </Note>
        </Section>

        <Section title="What each setting does">
          <Reference
            headers={["Setting", "Effect"]}
            rows={[
              [
                "Complexity",
                "Whether a password must mix character classes and avoid the account name.",
              ],
              ["Minimum length", "Shortest a password may be."],
              ["Passwords remembered", "How many previous ones cannot be reused."],
              [
                "Minimum age",
                "How long before it can be changed again — stops cycling back to an old one.",
              ],
              ["Maximum age", "How long before it must be changed. 0 means never."],
              ["Lock out after", "Failed attempts before the account locks. 0 is never."],
              ["Locked out for", "How long a lockout lasts."],
              ["Reset the count after", "How long a run of failures is remembered."],
            ]}
          />
        </Section>

        <Section title="Policies for particular people">
          <p>
            The domain policy is the floor. A policy object that names groups overrides it for
            their members — longer passwords for administrators, say — and where two reach the
            same account, the lower precedence wins.
          </p>
          <Note>
            Active Directory applies these to users and groups, <em>never</em> to a container. That
            is true in Samba too, and not a limitation of ODM: naming groups is how it is said, and
            membership is then what decides who the policy is for, so somebody added to the group
            afterwards is covered without anything being re-applied.
          </Note>
          <p>
            Removing the setting from the object, or deleting the object, removes what it wrote.
            A password settings object created by hand in the directory is left alone.
          </p>
        </Section>

        <Section title="A second factor">
          <p>
            <strong>Second factor</strong> in the top bar enrols a time-based code, scanned from a
            QR code into an authenticator app or a password manager. It protects this console only —
            signing in to a workstation is unaffected.
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

        <Section title="Changing your own password">
          <p>
            The current password is asked for every time, and it is checked by binding to the
            directory as that account. A session is not proof: a session can be a machine somebody
            walked away from.
          </p>
          <Note>
            This is a change, not a reset. Recovering a <em>forgotten</em> password needs a second
            factor to prove who is asking — an enrolled device or a verified address — and ODM has
            no such factor yet. Until it does, a forgotten password is a helpdesk reset, which is at
            least a human deciding.
          </Note>
        </Section>

        <Section title="Where each right sits">
          <Reference
            headers={["Action", "Needs"]}
            rows={[
              ["Read the policy", "Any signed-in administrator."],
              ["Change the policy", <C key="p">gpo.write</C>, ],
              ["Reset somebody else's password", <C key="a">user.password.reset</C>],
              ["Change your own", "Nothing but the current password, where policy allows it."],
            ]}
          />
        </Section>
      </Details>
    </>
  );
}
