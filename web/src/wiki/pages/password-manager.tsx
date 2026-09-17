import {
  C,
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
  id: "password-manager",
  title: "Password manager",
  section: "Administration",
  summary:
    "A vault for the domain, managed entirely from the console: seats, collections and who sees them.",
  keywords: [
    "password manager",
    "vault",
    "vaultwarden",
    "bitwarden",
    "extension",
    "desktop app",
    "collection",
    "organisation",
    "directory connector",
    "single sign-on",
    "openid",
    "oidc",
  ],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          The password-manager role runs Vaultwarden, the open-source Bitwarden server, and the
          console runs it: the console owns the vault&rsquo;s organisation through an account of
          its own, and everything an administrator decides &mdash; who has a seat, which
          collections exist, which domain groups see each one &mdash; is decided on the Passwords
          page and reconciled into the vault by the console. People sign in with their domain
          account, through the console, and use the vault &mdash; the browser extension, the
          desktop app, the Vault tab. Nobody administers it there.
        </p>

        <Example title="Set it up">
          <Steps>
            <li>
              A certificate authority under <strong>Certificates</strong>, if the domain has none:
              the console carries the vault&rsquo;s traffic over TLS it verifies against it.
            </li>
            <li>
              <strong>Server Roles</strong> → <strong>Password manager</strong> →{" "}
              <strong>Install on a server</strong>. Any member server; nobody connects to it
              directly. The vault is <C>https://&lt;console&gt;/vault</C>.
            </li>
            <li>
              <strong>Passwords</strong> → choose the groups whose members get a seat, any
              accounts besides, and &mdash; optionally &mdash; type your own domain password, then{" "}
              <strong>Set up the vault</strong>. The console sends the server its address and
              certificate, makes its own account in the vault and an organisation named after the
              domain, invites everyone with a seat, and &mdash; with your password given &mdash;
              sets your vault&rsquo;s master password to it. Nothing to copy, nothing to paste.
            </li>
            <li>
              <strong>Collections</strong>: make one per team, give it to the domain groups that
              should see it. Done; the console keeps the vault in step from here on.
            </li>
          </Steps>
        </Example>

        <Example title="Put it on the workstations">
          <strong>Group Policy</strong> → the policy object → <strong>Computer</strong> →{" "}
          <strong>Password manager</strong>: Bitwarden&rsquo;s browser extension and/or desktop
          app, already pointed at the vault, removed when the policy goes.
        </Example>

        <Example title="What a person sees">
          They open the vault (the extension is already there), press{" "}
          <strong>Log in with single sign-on</strong>, type their address &mdash; the mail
          attribute, or <C>name@domain</C> &mdash; and are signed in with their domain account,
          on their own workstation with no prompt at all. The first time they choose a master
          password; from then on the vault unlocks with it or a PIN, and their team&rsquo;s
          collections are simply there.
        </Example>

        <Where>Passwords; the extension and the app under a policy object&rsquo;s Computer settings.</Where>
      </Quickstart>

      <Details>
        <Section title="What the console holds, and what it cannot read">
          <p>
            The console&rsquo;s vault account is a domain user, <C>odm-vault</C>, made by the
            console; its master password is random and kept in the console&rsquo;s database like
            its other secrets. It owns the organisation, and the console keeps the
            organisation&rsquo;s key too &mdash; confirming a member (handing them the key, wrapped
            with their public key) and naming a collection are things only a holder of that key
            can do. That is the extent of it: what is <em>in</em> a collection is encrypted by the
            people who put it there, and personal vaults are encrypted with each person&rsquo;s
            own master password, which nothing on the server or in the console ever sees.
          </p>
          <Note>
            The master password remains each person&rsquo;s own. Given at setup, the
            administrator&rsquo;s domain password becomes their vault&rsquo;s master password once
            &mdash; derived into keys on the spot and not kept &mdash; because it is the password
            they already know. Everyone else chooses theirs at first sign-in. Changing a domain
            password later does not change a master password; there is no key on any server that
            could.
          </Note>
        </Section>

        <Section title="How the vault is kept in step">
          <p>
            Every five minutes, and within seconds of any change on the Passwords page, the
            console signs its account into the vault through single sign-on (it is the OpenID
            provider, so it issues its own code and never needs a password) and makes the vault
            match:
          </p>
          <Reference
            headers={["In the console", "In the vault"]}
            rows={[
              [
                "Seats: groups and accounts",
                "Every member of those groups (nesting included, disabled accounts left out) and every named account is invited; whoever has signed in since is confirmed; whoever is no longer entitled is removed from the organisation.",
              ],
              [
                "Groups",
                "Each domain group involved — with a seat, or with access to a collection — is a group of the organisation with the same members.",
              ],
              [
                "Collections and access",
                "Each collection exists under its name; the groups the console gives it are the groups that see it, read-only where the console says so. A collection removed here is removed there, with its contents.",
              ],
            ]}
          />
          <p>
            The result of the last pass is on the page, and the state of each seat: invited (has
            not signed in yet), signed in (being confirmed), confirmed.
          </p>
        </Section>

        <Section title="One address">
          <p>
            The vault answers at <C>/vault</C> on the console, and the console forwards each
            request to the server carrying the role, on port 8222, over TLS checked against the
            domain authority. The vault is told its own address is the console&rsquo;s, so every
            link it makes and the OpenID callback it registers point at the console; the console
            sends a browser that arrives under another of its names to the published one first,
            so the console, the vault and the sign-in are one origin.
          </p>
        </Section>

        <Section title="The certificate">
          <p>
            People only ever see the console&rsquo;s certificate. Between the console and the
            server carrying the vault there is a second one, from the domain authority, issued when
            the role is set up and kept while it has a month or more to run. The vault trusts the
            console&rsquo;s certificate through the server&rsquo;s own trust bundle, which the
            container carries — so the console&rsquo;s own certificate should be one the authority
            issued (<strong>Certificates</strong> → <strong>Replace console certificate</strong>).
          </p>
        </Section>

        <Section title="Removing the role">
          <p>
            <strong>Server Roles</strong> → <strong>Remove</strong> stops the vault and removes its
            configuration from the server; <C>/var/lib/odm/vaultwarden</C> &mdash; the vaults
            themselves &mdash; stays, because it cannot be made again. The console&rsquo;s record
            of the organisation stays too, so installing the role again on the same server finds
            everything as it was.
          </p>
        </Section>
      </Details>
    </>
  );
}
