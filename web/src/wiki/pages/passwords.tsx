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
          The password policy lives in the directory, not in ODM&rsquo;s database. Samba enforces
          it on every password change however it is made — through this console, from a client,
          or with samba-tool — so there is one rule rather than one rule and a copy of it.
        </p>

        <Example title="Change what a password has to be">
          <strong>Overview</strong> → <strong>Password policy</strong>. Set what you want to
          change and leave the rest empty. It applies to the next password set, not to existing
          ones.
        </Example>

        <Example title="Let people change their own">
          <strong>Group Policy</strong> → <strong>User</strong> →{" "}
          <strong>Self-service password</strong>. Not configured anywhere means yes; a policy
          object is how it is taken away.
        </Example>

        <Example title="Change your own">
          <strong>Change password</strong> in the top bar, next to Sign out. It appears when
          policy allows it for your account.
        </Example>

        <Example title="Reset somebody else's">
          <strong>Directory</strong> → the user → <strong>Reset password</strong>. Needs{" "}
          <C>user.password.reset</C>, which helpdesk holds.
        </Example>

        <Where>Overview → Password policy for the rule; the top bar for your own.</Where>
      </Quickstart>

      <Details>
        <Section title="What each setting does">
          <Reference
            headers={["Setting", "Effect"]}
            rows={[
              ["Complexity", "Whether a password must mix character classes and avoid the account name."],
              ["Minimum length", "Shortest a password may be."],
              ["Passwords remembered", "How many previous ones cannot be reused."],
              ["Minimum age", "How long before it can be changed again — stops cycling back to an old one."],
              ["Maximum age", "How long before it must be changed. 0 means never."],
              ["Lock out after", "Failed attempts before the account locks. 0 is never."],
              ["Locked out for", "How long a lockout lasts."],
              ["Reset the count after", "How long a run of failures is remembered."],
            ]}
          />
        </Section>

        <Section title="Changing your own password">
          <p>
            The current password is asked for every time, and it is checked by binding to the
            directory as that account. A session is not proof: a session can be a machine
            somebody walked away from.
          </p>
          <Note>
            This is a change, not a reset. Recovering a <em>forgotten</em> password needs a
            second factor to prove who is asking — an enrolled device or a verified address —
            and ODM has no such factor yet. Until it does, a forgotten password is a helpdesk
            reset, which is at least a human deciding.
          </Note>
        </Section>

        <Section title="Where each right sits">
          <Reference
            headers={["Action", "Needs"]}
            rows={[
              ["Read the policy", "Any signed-in administrator."],
              ["Change the policy", "Membership of the domain administrators group."],
              ["Reset somebody else's password", <C key="a">user.password.reset</C>],
              ["Change your own", "Nothing but the current password, where policy allows it."],
            ]}
          />
        </Section>
      </Details>
    </>
  );
}
