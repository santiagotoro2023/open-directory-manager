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
            ["Is the control plane up?", <Code key="a">curl --cacert /etc/odm/tls/api.crt https://&lt;console&gt;:8443/api/v1/healthz</Code>],
            ["What did ODM think happened?", "Audit Log, filtered by actor or object."],
            ["What did the machine do?", "Directory → the computer → Policy → the agent's report."],
            ["Is the domain healthy?", "Operations → Health."],
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

        <Section title="A setting fails to apply">
          <p>The agent report names the setting and the reason.</p>
          <Reference
            headers={["Reason", "Usually"]}
            rows={[
              ["unknown state", "A systemd unit state that is not one of the five supported values."],
              ["visudo failed", "The sudo rule would not parse. It was not installed."],
              ["no command runner", "The agent is running in a mode that cannot execute commands."],
              ["a permissions error", "The agent is not running as root, or a path is on a read-only mount."],
              ["skipped: not a PEM certificate", "A trusted-certificate entry does not contain a certificate."],
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
              ["Clock skew", "Kerberos rejects tickets more than five minutes out. Synchronise time first."],
              ["Pre-authentication failed", "The join credential is wrong, or the account is disabled."],
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
              ["The peer shows as unreachable", "Check the peer node's service and that both URLs are correct on both nodes."],
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
