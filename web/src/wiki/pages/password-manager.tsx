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
    "A vault for the domain, inside the console: seats and groups from the directory, sign-in with the domain account.",
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
          The password-manager role runs Vaultwarden, the open-source Bitwarden server, and
          makes it part of the domain. Its address is the console&rsquo;s own &mdash;{" "}
          <C>https://&lt;console&gt;/vault</C> &mdash; whichever member server carries it: the
          console shows it on the Passwords page and carries every request to that server, so
          there is one address, one certificate and one sign-in for the whole thing. There are
          no accounts of its own to make and no groups of its own to keep: a person has a seat
          because they are in a domain group, the vault&rsquo;s groups are the domain&rsquo;s
          groups with the same members, kept in step by a sync on the server, and people sign in
          with their domain account &mdash; through the console, which is the domain&rsquo;s
          OpenID provider, and without typing anything on a domain-joined desktop whose browser
          hands over the ticket it already holds. What is <em>in</em> a vault, the server cannot
          read &mdash; every vault is encrypted with a key only its owner has &mdash; which is the
          point of a password manager and the one thing this role does not change.
        </p>

        <Example title="Set it up">
          <Steps>
            <li>
              A certificate authority, under <strong>Certificates</strong>, if the domain has
              none yet: the console carries the vault&rsquo;s traffic over TLS it verifies
              against it, and refuses to carry anything until it can.
            </li>
            <li>
              <strong>Server Roles</strong> → <strong>Password manager</strong> →{" "}
              <strong>Install on a server</strong> &mdash; any member server; nobody connects to it
              directly. The installer prints the admin page&rsquo;s token once, and the console
              sends the vault its address and certificate the moment the install is reported
              done.
            </li>
            <li>
              <strong>Passwords</strong> → the <strong>Vault</strong> tab: create the first
              account and, in it, an organisation with a collection per team. This first account
              is the organisation&rsquo;s owner; the console never holds its password.
            </li>
            <li>
              In the organisation, <strong>Settings</strong> → <strong>API key</strong>. Paste
              the client id and secret on the <strong>Setup</strong> tab.
            </li>
            <li>
              Choose the groups whose members get a seat &mdash; <C>%Sales</C>,{" "}
              <C>%Finance</C> &mdash; and <strong>Save and apply</strong>. The server fetches
              the directory connector, binds to the domain with a read-only account the console
              made for it, and invites everybody in those groups.
            </li>
            <li>
              Back in the organisation, its <strong>Groups</strong> now mirror those directory
              groups. Give each its collection, once. From then on, joining the domain group is
              what gives someone the team&rsquo;s vault, and leaving it takes it away at the next
              sync.
            </li>
          </Steps>
        </Example>

        <Example title="Put it on every workstation">
          <strong>Group Policy</strong> → the policy object → <strong>Computer</strong> →{" "}
          <strong>Password manager</strong>. Tick the browser extension, the desktop app, or both:
          Bitwarden&rsquo;s extension is installed in Firefox and Chromium and its desktop app on
          the machine, each pointed at the domain&rsquo;s vault so nobody types a server address,
          and each removed again when the policy stops reaching the machine. The browsers&rsquo;
          own password saving is turned off alongside, so the vault is the one place a password
          is offered from.
        </Example>

        <Example title="What a person sees">
          A mail (or a word from the administrator) says they have a seat. They open the vault
          &mdash; the extension or the app is already there, already pointed at it &mdash; press{" "}
          <strong>Log in with single sign-on</strong>, and are signed in with their domain account:
          on their own workstation, with no prompt at all. The first time, they choose a master
          password; after that the extension unlocks with it or with a PIN, and the team&rsquo;s
          passwords are simply there.
        </Example>

        <Where>
          Passwords &mdash; the Vault tab is the vault, the Setup tab what the console decides
          &mdash; once a server carries the password-manager role; the extension and the app under
          a policy object&rsquo;s Computer settings.
        </Where>
      </Quickstart>

      <Details>
        <Section title="What the directory decides, and what it cannot">
          <p>
            Seats and teams come from the directory and nowhere else. A person&rsquo;s seat is
            their domain account &mdash; the vault knows them by the address the directory holds
            for them, or their account name at the domain where none is set &mdash; and sign-ups
            are closed, so the only way in is to be in one of the chosen groups. The
            organisation&rsquo;s groups are the domain groups, created and emptied by the sync; the
            one decision made inside the vault is which collection each group sees, and it is made
            once, because the group keeps its collection however its membership changes.
          </p>
          <p>
            Signing in is the domain&rsquo;s too. The vault is a client of the console&rsquo;s
            OpenID Connect provider (<C>/api/v1/oidc</C>), registered by the console when the
            role is configured; <strong>Log in with single sign-on</strong> sends the person to
            the console, which accepts the Kerberos ticket the browser offers &mdash; the one the
            desktop session got at login &mdash; or, from a machine without one, their domain
            name and password on the console&rsquo;s own page, with the same lockout as the
            console&rsquo;s sign-in. The vault is told who they are and their address, and never
            sees a password. With <strong>and only that way</strong> ticked the vault&rsquo;s own
            password sign-in is switched off, so a disabled domain account is a closed vault at
            once.
          </p>
          <p>
            What the directory cannot do is unlock a vault. A vault is encrypted end to end with a
            key derived from its owner&rsquo;s master password; the server holds only ciphertext,
            and so does the console. That is why each person chooses a master password of their
            own the first time they sign in &mdash; no server that could stand in for it would be
            a password manager worth having. The extension asks for it once; after that it stays
            signed in and unlocks with it, a PIN or the machine&rsquo;s biometrics, the way
            Bitwarden itself works in any organisation.
          </p>
          <Note>
            This is the same arrangement as Bitwarden&rsquo;s own enterprise deployment &mdash;
            directory connector plus single sign-on &mdash; with the provider, the connector, its
            account, its certificate and its schedule all set up and kept running by the role, and
            the clients by policy.
          </Note>
        </Section>

        <Section title="One address">
          <p>
            The vault answers at <C>/vault</C> on the console, and the console forwards each
            request &mdash; the web vault&rsquo;s pages, the extension&rsquo;s and the app&rsquo;s
            calls, the live-update socket &mdash; to the server carrying the role, on port 8222,
            over TLS checked against the domain authority. The vault is told its own address is
            the console&rsquo;s (<C>DOMAIN</C> in its configuration), so every link it makes,
            every invitation it sends and the OpenID callback it registers point at the console.
            The console&rsquo;s own gates step aside for that path: the vault does its own
            sign-in, sets its own headers and answers the browser extensions&rsquo; cross-origin
            requests itself, so none of the console&rsquo;s origin, CORS or content-security rules
            are applied to it &mdash; only transport security is.
          </p>
          <Note>
            The Passwords page shows the vault in a frame of the same origin, which is why the
            vault&rsquo;s own <C>frame-ancestors &apos;self&apos;</C> allows it. <strong>Open in a
            tab</strong> is the same address without the console around it, for a second monitor
            or a longer session.
          </Note>
        </Section>

        <Section title="The sync">
          <p>
            The server runs Bitwarden&rsquo;s directory connector (<C>bwdc</C>) on a systemd timer,
            every hour unless told otherwise, and once at each <strong>Apply</strong>. It binds to
            the domain over LDAPS as <C>odm-passwords-sync</C>, a domain user with no memberships
            and a random password the console made when the organisation key was first saved;
            it reads what any domain user may read &mdash; names, mail addresses and group
            members. It syncs exactly the chosen groups and the members of those groups: anyone
            in them is invited, anyone who leaves them all is removed from the organisation, and
            a disabled account is removed too.
          </p>
          <Reference
            headers={["On the server", "Holds"]}
            rows={[
              [<C key="a">/etc/odm/vaultwarden/env</C>, "The vault's address, mail relay and admin token"],
              [<C key="b">/etc/odm/vaultwarden/tls/</C>, "Its certificate, from the domain authority once configured"],
              [<C key="c">/var/lib/odm/vaultwarden/</C>, "The vaults themselves, encrypted; back this up"],
              [<C key="d">/opt/odm/bwdc/</C>, "The directory connector"],
              [<C key="e">odm-bwdc-sync.timer</C>, "The sync's schedule; journalctl -u odm-bwdc-sync for its log"],
            ]}
          />
          <Note>
            A person is told about their invitation by mail, if a relay is set under{" "}
            <strong>Invitations by mail</strong>. Without one the invitation still exists; the
            organisation&rsquo;s owner sees it under <strong>Members</strong> and can hand the link
            over. The relay is what makes joining self-service.
          </Note>
        </Section>

        <Section title="The certificate">
          <p>
            People and their browsers only ever see the console&rsquo;s certificate. Between the
            console and the server carrying the vault there is a second one: the vault starts
            with a self-signed certificate so the service comes up, and the configuration the
            console sends when the install is reported done &mdash; and at every{" "}
            <strong>Apply</strong> &mdash; replaces it with one from the domain authority, in the
            server&rsquo;s name, which is what the console checks before forwarding anything. The
            vault in turn has to trust the console&rsquo;s certificate to send people there to sign
            in: the container carries the server&rsquo;s own trust bundle, which holds the domain
            authority once the agent has installed it, so the console&rsquo;s own certificate
            should be one the authority issued (<strong>Certificates</strong> →{" "}
            <strong>Replace console certificate</strong>) rather than the self-signed one setup
            starts with.
          </p>
        </Section>

        <Section title="The admin page">
          <p>
            Vaultwarden&rsquo;s own admin page is at <C>/vault/admin</C> on the console, behind
            the token the installer printed (it is in <C>/etc/odm/vaultwarden/admin-token</C> on
            the server). It shows users, lets one be deleted or its two-factor reset, and sends a test
            mail. Everything the console sets it sets through the environment file, so a change
            made on the admin page to a setting the console owns is overwritten at the next apply.
          </p>
        </Section>

        <Section title="Removing the role">
          <p>
            <C>deploy/uninstall.sh</C> on the server stops the container and the sync, and leaves{" "}
            <C>/var/lib/odm/vaultwarden</C> in place: the vaults are the one thing on that machine
            that cannot be made again.
          </p>
        </Section>
      </Details>
    </>
  );
}
