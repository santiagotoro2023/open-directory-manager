import {
  C,
  Code,
  Details,
  Example,
  Note,
  Quickstart,
  Reference,
  Section,
  Where,
} from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "agent",
  title: "Policy agent",
  section: "Clients",
  summary:
    "The agent on every domain member: how it authenticates, when it runs, and what it reports.",
  keywords: ["agent", "odm-agent", "gpupdate", "apply", "refresh", "rsop", "daemon", "kerberos"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          <C>odm-agent</C> runs on every domain member &mdash; controllers included. It
          authenticates with the machine&rsquo;s own Kerberos keytab, asks the control plane what
          policy applies to it, applies the answer, and reports what happened. It is also what
          installs a server role, because the control plane runs sandboxed and unprivileged and
          cannot install packages even on its own host.
        </p>

        <Note>
          A machine with no agent appears in the console but nothing can be done to it: no role
          installed, no inventory, no policy. <C>setup.sh</C> installs the agent on the first
          controller as its last step, and <C>odm-client-install</C> installs it on everything else
          as part of joining.
        </Note>

        <Example title="Apply policy immediately">
          <Code>sudo odm-agent apply --force</Code>
          Without <C>--force</C>, an unchanged policy is a no-op.
        </Example>

        <Example title="Check the service">
          <Code>{`systemctl status odm-agent
journalctl -u odm-agent -n 50`}</Code>
        </Example>

        <Example title="See what it reported">
          In the console: <strong>Directory</strong> → select the computer → <strong>Policy</strong>
          .
        </Example>

        <Where>
          Directory → a computer → Policy shows both the resolved policy and the agent's report.
        </Where>
      </Quickstart>

      <Details>
        <Section title="Commands">
          <Reference
            headers={["Command", "Does"]}
            rows={[
              [
                <C key="1">odm-agent apply</C>,
                "Fetches and applies policy if it has changed since the last run.",
              ],
              [
                <C key="2">odm-agent apply --force</C>,
                "Applies regardless of whether anything changed.",
              ],
              [
                <C key="3">odm-agent apply --user NAME</C>,
                "Applies the policy resolved for one user on this machine.",
              ],
              [
                <C key="4">odm-agent daemon</C>,
                "Applies on the refresh interval. This is what the service runs.",
              ],
              [
                <C key="6">odm-agent check</C>,
                "Says why this machine is not reporting: every step from configuration to check-in, in order, with the real error.",
              ],
              [
                <C key="7">odm-agent trust FILE</C>,
                "Trusts the console's certificate and re-checks. For a machine that cannot read it from the domain.",
              ],
              [<C key="5">odm-agent --version</C>, "Prints the version."],
            ]}
          />
          <p>
            <C>--root DIR</C> writes beneath a directory instead of <C>/</C>, for inspecting what a
            policy would produce without changing the machine.
          </p>
        </Section>

        <Section title="A machine that has joined and reports nothing">
          <p>
            Run <C>sudo odm-agent check</C> on it. Each step between joined and reporting is
            checked in order — configuration, the machine account in the keytab, reaching the
            console, Kerberos, fetching policy, checking in — and the first failure is the answer.
          </p>
          <Reference
            headers={["What check says", "Fix"]}
            rows={[
              [
                "the console's certificate: ... no domain controller found",
                <>
                  The machine could not find a controller to read the anchor from. It asks DNS for{" "}
                  <C key="srv">_ldap._tcp.dc._msdcs.&lt;domain&gt;</C> and falls back to the
                  console&rsquo;s own host, so this means the resolver is not the domain&rsquo;s.
                  Check <C key="rc">/etc/resolv.conf</C>.
                </>,
              ],
              [
                "reaching the control plane: x509: certificate signed by unknown authority",
                <>
                  The machine has no copy of the console&rsquo;s certificate, or the copy is out of
                  date. It fetches one from the domain by itself — <C key="t1">check</C> does it
                  too — so this means SYSVOL has none: run{" "}
                  <C key="t2">deploy/publish-console-certificate.sh</C> on the controller. Or hand
                  it over directly with <C key="t3">sudo odm-agent trust /path/to/api.crt</C>.
                </>,
              ],
              [
                "keytab holds no entry for HOSTNAME$",
                <>
                  The keytab is another machine&rsquo;s, or the join did not write one. Re-join, or
                  on a controller: <C key="t4">samba-tool domain exportkeytab /etc/krb5.keytab
                  --principal=HOSTNAME$</C>.
                </>,
              ],
              [
                "Kerberos: KRB_AP_ERR_SKEW, or a ticket refused",
                "The clock. A ticket outside five minutes is refused; install chrony and let it settle.",
              ],
              [
                "fetching policy: 401",
                "The service principal in the configuration is not the one the console answers to, or the console's own keytab is wrong.",
              ],
              [
                "fetching policy: 404",
                "The directory has no computer account for this machine — it was deleted, or the machine was renamed after joining.",
              ],
              [
                "reaching the control plane: no such host",
                <>
                  The name in <C key="t5">api_url</C> does not resolve. The domain&rsquo;s DNS is
                  the controller; check <C key="t6">/etc/resolv.conf</C>.
                </>,
              ],
            ]}
          />
          <Note>
            The service keeps trying on its interval, so nothing has to be restarted after a fix —
            but <C>odm-agent apply --force</C> makes it immediate.
          </Note>
        </Section>

        <Section title="Configuration">
          <p>
            Written by the join client to <C>/etc/odm/agent.json</C>.
          </p>
          <Reference
            headers={["Key", "Meaning"]}
            rows={[
              ["api_url", "The control plane. HTTPS only."],
              ["service_principal", "The control plane's service principal name."],
              ["keytab", "The machine keytab, normally /etc/krb5.keytab."],
              ["realm", "The Kerberos realm."],
              ["ca_cert", "The certificate that validates the control plane's TLS certificate."],
              [
                "refresh_minutes",
                "Interval to use until the domain's own is known — at first start, before the machine has reached the control plane.",
              ],
            ]}
          />
        </Section>

        <Section title="The refresh cycle">
          <Reference
            headers={["Step", "What happens"]}
            rows={[
              [
                "Authenticate",
                "SPNEGO with the machine keytab. No agent credential exists separately.",
              ],
              [
                "Report facts",
                "The operating system identifier and current addresses, for item-level targeting.",
              ],
              [
                "Compare",
                "If the policy fingerprint matches the last applied one, nothing is done.",
              ],
              ["Apply", "Each category in turn. A failing category does not stop the others."],
              ["Prune", "Files owned by the previous run but not this one are removed."],
              ["Report", "Per-setting success, failure or skip is posted back."],
            ]}
          />
          <p>
            The interval is a domain setting, under{" "}
            <strong>Domain Controllers &rarr; Agents</strong>: 1, 5, 15 or 30 minutes, 15 by
            default. It arrives in the policy document the agent already fetches, so a change takes
            effect at each machine&rsquo;s next poll. A small random offset is added so a fleet does
            not check in at the same instant.
          </p>
          <p>
            The agent records the interval it was last told in{" "}
            <C>/var/lib/odm/refresh-minutes</C> and keeps using it across a restart and while the
            control plane is unreachable. Without that file it uses <C>refresh_minutes</C> from its
            configuration, and 15 minutes without that.
          </p>
          <Note>
            With push on for the domain, a policy edit queues a refresh for every machine that has
            reported, and the held request below carries it — so an edit applies within seconds
            rather than at the next poll. It is off by default.
          </Note>
          <Note>
            Queued work &mdash; a role to install, a restart, a share to render &mdash; does not
            wait for the next policy refresh. Between refreshes the agent asks for work and the
            control plane holds that request open until there is some, so an action taken in the
            console starts within a second. Policy itself is still only re-applied when it has
            changed.
          </Note>
          <p>
            Packages are installed outside the agent&rsquo;s own systemd sandbox, as a transient
            unit started by <C>systemd-run</C>. A service&rsquo;s restrictions are inherited by
            everything it starts, and a Debian package&rsquo;s post-installation script is ordinary
            root code written against an ordinary machine: run under the agent&rsquo;s
            restrictions, some of them fail in ways that look like a broken package.
          </p>
        </Section>

        <Section title="Verifying the console">
          <p>
            The agent holds a copy of the console&rsquo;s certificate, at{" "}
            <C>/etc/odm/tls/api-ca.pem</C>, because a self-signed certificate is in no
            machine&rsquo;s trust store. The domain publishes it in SYSVOL and the join reads it
            from there, so nothing is carried to a machine by hand.
          </p>
          <p>
            When verification fails — a replaced certificate, or a machine joined before it was
            published — the agent fetches it again from SYSVOL as the machine account, over
            Kerberos with mandatory signing, and retries the request once. A domain that issues
            itself a real certificate would otherwise silence every agent in it.
          </p>
          <Note>
            Only a verification failure is healed this way. A refused ticket, a name that does not
            resolve or a rejected request are different problems, and re-fetching the certificate
            would not touch them.
          </Note>
        </Section>

        <Section title="Files the agent owns">
          <Reference
            headers={["Path", "Holds"]}
            rows={[
              [<C key="1">/etc/odm/agent.json</C>, "Agent configuration."],
              [<C key="2">/var/lib/odm/managed-state.json</C>, "Every path the last run wrote."],
              [
                <C key="3">/var/lib/odm/last-serial</C>,
                "The fingerprint of the last applied policy.",
              ],
              [
                <C key="7">/var/lib/odm/refresh-minutes</C>,
                "The polling interval the domain last set.",
              ],
              [<C key="4">/etc/odm/scripts/</C>, "Deployed scripts, by trigger."],
              [<C key="5">/etc/odm/firewall.nft</C>, "The generated nftables ruleset."],
              [<C key="6">/usr/lib/odm/pam-session-hook</C>, "The login hook."],
            ]}
          />
          <p>
            Every file the agent writes carries a header saying it is managed and that local edits
            are overwritten. Files in configuration another package owns —{" "}
            <C>/etc/security/access.conf</C>, <C>/etc/pam.d/common-session</C> — are edited only
            between markers, leaving the rest untouched.
          </p>
        </Section>

        <Section title="Removing a setting">
          <p>
            The paths written by each run are recorded. When a setting is removed from a policy
            object, the next run notices the file is no longer owned and deletes it, reporting the
            removal.
          </p>
        </Section>

        <Section title="User policy at login">
          <p>
            The PAM session hook runs logon scripts and, in the background behind a timeout, asks
            the control plane for the policy that applies to the user signing in. Only user-scoped
            categories are applied that way — drive maps and the desktop background — so logging in
            cannot reconfigure the machine.
          </p>
        </Section>

        <Section title="Reading a report">
          <Reference
            headers={["Status", "Means"]}
            rows={[
              ["success", "The setting was applied."],
              ["failed", "The setting could not be applied. The reason is shown."],
              ["skipped", "The setting did not apply here, with the reason."],
              ["removed:<path>", "A file from a previous policy was deleted."],
            ]}
          />
          <p>
            A report also carries the policy fingerprint, so the console can say whether a machine
            is running the current policy or an older one.
          </p>
        </Section>
      </Details>
    </>
  );
}
