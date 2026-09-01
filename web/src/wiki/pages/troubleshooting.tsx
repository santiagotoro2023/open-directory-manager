import { C, Code, Details, Quickstart, Reference, Section } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "troubleshooting",
  title: "Troubleshooting",
  section: "Reference",
  summary: "What to check when sign-in, policy, join, DNS, DHCP or certificates do not behave.",
  keywords: ["troubleshoot", "problem", "error", "fix", "debug", "not working", "fails"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>Four checks resolve most problems.</p>
        <Reference
          headers={["Check", "How"]}
          rows={[
            [
              "Is the control plane up?",
              <Code key="a">
                curl --cacert /etc/odm/tls/api.crt https://&lt;console&gt;:8443/api/v1/healthz
              </Code>,
            ],
            ["What did ODM think happened?", "Audit Log, filtered by actor or object."],
            ["What did the machine do?", "Directory → the computer → Policy → the agent's report."],
            ["Is the domain healthy?", "Overview → Health."],
          ]}
        />
      </Quickstart>

      <Details>
        <Section title="Sign-in">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                "Refused with a message about delegation",
                "The account is not in the administrators group and holds no assignment. Delegation → New assignment.",
              ],
              [
                "Invalid credentials for a password that is correct",
                "The account may be disabled or locked. Check it under Directory, and check the clock on the control plane host.",
              ],
              [
                "Too many failed attempts",
                "The lockout window has not elapsed. It applies per account name and per source address.",
              ],
              [
                "Session ends unexpectedly",
                "Sessions have an absolute lifetime and an idle timeout, and are revoked when the account loses every right. The revocation is in the audit log.",
              ],
              [
                "The browser refuses to connect",
                "There is no plaintext listener. Use https, and confirm the certificate and key are readable by the service user.",
              ],
            ]}
          />
        </Section>

        <Section title="Policy not arriving">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                "Nothing applies to a machine",
                "The policy object must be linked to a container above the host, and the link enabled. The Policy dialog lists skipped objects with the reason.",
              ],
              [
                "Skipped: security filtering",
                "The computer is not in the filter. Filters follow nested group membership.",
              ],
              [
                "Skipped: os / hostname / ip targeting",
                "Item-level targeting did not match the facts the machine reported.",
              ],
              [
                "Skipped: inheritance blocked",
                "An organizational unit between the object and the link blocks inheritance. Enforce the link to override it.",
              ],
              [
                "The wrong value wins",
                "The policy applied last wins. Check link order — 1 is highest — and whether another link is enforced.",
              ],
              [
                "The agent never reports",
                <>
                  On the client: <C key="c">systemctl status odm-agent</C> and{" "}
                  <C key="d">odm-agent apply --force</C>.
                </>,
              ],
            ]}
          />
        </Section>

        <Section title="Server roles">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                'A role sits in "installing" and never finishes',
                <>
                  The target machine has no agent, so nothing collected the work. Check{" "}
                  <C key="a">systemctl status odm-agent</C> on it. Installs are run by the agent on
                  the machine the role goes on &mdash; the control plane runs sandboxed and installs
                  nothing itself, on any host. After 45 minutes the role is marked failed on its
                  own, with the reason on the row, and can be installed again.
                </>,
              ],
              [
                "Unmet dependencies for a package the archive plainly has",
                <>
                  An earlier failure left <C key="d">dpkg</C> half-configured, and from then on
                  every install fails for a reason that has nothing to do with the role being
                  installed. The installers repair this before they begin; if one still reports it,
                  run <C key="e">dpkg --configure -a</C> on the machine and read what it says.
                </>,
              ],
              [
                "A service the role installed refuses to start",
                "Server Roles → the role → the failed server. The unit's own journal is under the row, not just its name.",
              ],
              [
                '"is not installed on this machine"',
                <>
                  The installers ship with the agent, in <C key="b">/usr/lib/odm/roles/</C>.
                  Reinstall the agent on that machine.
                </>,
              ],
              [
                "The controller carries no agent after setup",
                <>
                  Re-run it and read the tail of <C key="c">/var/log/odm-agent-install.log</C>,
                  which setup prints when this fails. Usually a machine keytab that could not be
                  exported, or no network to build the binary.
                </>,
              ],
              [
                "The installer's own error",
                "Server Roles → the role → the failed server. The last of its output is under the row.",
              ],
            ]}
          />
        </Section>

        <Section title="Directory writes">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                '"this account may not reset passwords in the directory"',
                <>
                  Writing a password is a control-access right of its own, not a property write.
                  Re-run <C key="p">deploy/create-api-service-account.sh</C> on a domain controller
                  &mdash; it is safe to run again &mdash; and restart the control plane. Domains
                  provisioned before this was granted are the ones that hit it.
                </>,
              ],
              [
                "A row of tildes and carets where an error should be",
                <>
                  Fixed: <C key="q">samba-tool</C> reports a failure as a Python traceback, and the
                  console used to show its last line, which is the marker under the expression that
                  raised rather than the message. Upgrade the control plane.
                </>,
              ],
            ]}
          />
        </Section>

        <Section title="Operations">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                "Replication says the account may not read replication state",
                <>
                  Reading the topology and forcing a run are separate directory rights. Run{" "}
                  <C key="e">deploy/create-api-service-account.sh</C> on a domain controller to
                  grant them.
                </>,
              ],
              [
                "Only one domain controller is listed",
                "Controllers are read from their computer accounts. A second one appears once it has joined and replicated.",
              ],
            ]}
          />
        </Section>

        <Section title="A setting fails to apply">
          <p>The agent report names the setting and the reason.</p>
          <Reference
            headers={["Reason", "Usually"]}
            rows={[
              [
                "unknown state",
                "A systemd unit state that is not one of the five supported values.",
              ],
              ["visudo failed", "The sudo rule would not parse. It was not installed."],
              ["no command runner", "The agent is running in a mode that cannot execute commands."],
              [
                "a permissions error",
                "The agent is not running as root, or a path is on a read-only mount.",
              ],
              [
                "skipped: not a PEM certificate",
                "A trusted-certificate entry does not contain a certificate.",
              ],
            ]}
          />
        </Section>

        <Section title="Setting up">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                "samba-tool: command not found",
                <>
                  It ships in <C key="a">python3-samba</C> on Debian 13 and{" "}
                  <C key="b">samba-common-bin</C> on Debian 12. Setup installs whichever the release
                  has; if it is still missing, install it and run setup again.
                </>,
              ],
              [
                "Unit samba-ad-dc.service does not exist",
                <>
                  The service ships in the <C key="c">samba-ad-dc</C> package on Debian 13 and in{" "}
                  <C key="d">samba</C> on Debian 12.
                </>,
              ],
              [
                "Could not resolve the security identifier",
                "samba-ad-dc had not finished starting. Setup waits for it; if it still fails, check systemctl status samba-ad-dc.",
              ],
              [
                "Setup stopped at a step",
                "Nothing after that point ran. Fix the cause and run setup again — completed steps are skipped.",
              ],
              [
                "The console does not answer after setup",
                <>
                  <C key="e">journalctl -u odm-api -n 50</C>. The usual causes are a keytab or
                  directory CA the service cannot read.
                </>,
              ],
            ]}
          />
        </Section>

        <Section title="Joining">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                "The domain cannot be found",
                <>
                  The client must resolve the domain&rsquo;s service records:{" "}
                  <C key="e">host -t SRV _ldap._tcp.corp.example.internal</C>.
                </>,
              ],
              [
                "Clock skew",
                "Kerberos rejects tickets more than five minutes out. Synchronise time first.",
              ],
              [
                "Pre-authentication failed",
                "The join credential is wrong, or the account is disabled.",
              ],
              [
                "Joined, but domain users do not resolve",
                <>
                  Check SSSD: <C key="f">systemctl status sssd</C> and{" "}
                  <C key="g">id someone@corp.example.internal</C>.
                </>,
              ],
              [
                "The computer is missing from the directory",
                "Look in the container the join used, and in the recycle bin in case an old account was deleted.",
              ],
            ]}
          />
        </Section>

        <Section title="DNS and DHCP">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                "DNS says it is unavailable",
                "DNS management needs the control plane on a domain controller.",
              ],
              [
                "A record is refused",
                "Data is validated for its type. An A record needs an IPv4 address; an SRV record needs all four fields.",
              ],
              [
                "DHCP says the role is not installed",
                "Install it from Server Roles, then add the ODM_KEA_* settings and restart the control plane.",
              ],
              [
                "A scope change is refused",
                "The change was tested against the DHCP service and rejected. Pools must lie inside their subnet and run forwards.",
              ],
              [
                "Leases do not appear in DNS",
                "The dynamic-update path needs the GSS-TSIG hook and a keytab. The role installer reports when the hook is missing.",
              ],
              [
                "The peer shows as unreachable",
                "Check the peer node's service and that both URLs are correct on both nodes.",
              ],
            ]}
          />
        </Section>

        <Section title="Certificates">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                "Certificates says the role is not configured",
                <>
                  Install the certificate-authority role and set <C key="h">ODM_CA_DIR</C>.
                </>,
              ],
              [
                "Issued and staged, but nothing was replaced",
                "The privileged helper is not installed. Install odm-apply-console-certificate and the sudoers rule.",
              ],
              [
                "Clients still do not trust the certificate",
                "Publish the root to the domain, and confirm the agent applied it: the report shows trusted_certificates.",
              ],
              [
                "The console did not come back after a certificate change",
                <>
                  The previous pair is kept as <C key="i">api.crt.previous</C> and{" "}
                  <C key="j">api.key.previous</C>. Restore them and restart the service.
                </>,
              ],
            ]}
          />
        </Section>

        <Section title="Where to look">
          <Code>{`journalctl -u odm-api -n 100        # control plane
journalctl -u samba-ad-dc -n 100    # domain controller
journalctl -u odm-agent -n 100      # a client
journalctl -u kea-dhcp4-server      # DHCP`}</Code>
        </Section>
      </Details>
    </>
  );
}
