import { C, Code, Details, Example, Note, Quickstart, Reference, Section, Steps, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "certificates",
  title: "Certificates",
  section: "Network services",
  summary: "The domain certificate authority: issuing, publishing trust, revocation, and the console's own certificate.",
  keywords: ["ca", "certificate", "tls", "https", "pki", "crl", "revoke", "trust", "self-signed"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          The console is served over HTTPS from the first boot with a self-signed certificate.
          Installing the certificate-authority role gives the domain its own authority, which can
          issue certificates for services and clients, distribute its root to every domain member,
          and replace the console&rsquo;s own certificate.
        </p>

        <Example title="Set up the authority">
          <Steps>
            <li>
              <strong>Server Roles</strong> → <strong>Certificate authority</strong> →{" "}
              <strong>Install</strong>.
            </li>
            <li>
              Add the printed <C>ODM_CA_DIR</C> to the secrets file and restart the control plane.
            </li>
            <li>
              <strong>Certificates</strong> → <strong>Create the certificate authority</strong>.
            </li>
            <li>
              <strong>Publish to domain</strong> so members install the root into their trust
              store.
            </li>
          </Steps>
        </Example>

        <Example title="Issue a certificate for a service">
          <strong>Issue certificate</strong> → common name{" "}
          <C>fs01.corp.example.internal</C>, additional names as needed, profile{" "}
          <strong>Server</strong>. Copy the certificate and key from the dialog; the key is shown
          once.
        </Example>

        <Example title="Replace the console certificate">
          <strong>Replace console certificate</strong> → the name operators use to reach the
          console → <strong>Issue and apply</strong>. The console restarts.
        </Example>

        <Where>Certificates. The role is installed from Server Roles.</Where>
      </Quickstart>

      <Details>
        <Section title="Certificates that arrive on their own">
          <p>
            <strong>Group Policy</strong> → <strong>Computer</strong> →{" "}
            <strong>Certificates</strong> gives machines a certificate without anyone issuing one
            by hand, and replaces it before it expires.
          </p>
          <Reference
            headers={["Part", "How it works"]}
            rows={[
              [
                "The subject",
                "Never sent by the machine. It asks for \u201ca certificate\u201d and the control plane names it from the Kerberos identity that asked \u2014 so a machine can obtain one for itself and for nothing else.",
              ],
              [
                "The key",
                <>
                  Written to the path in the policy as <C key="k">&lt;profile&gt;.key</C>, mode
                  0600 and owned by root.
                </>,
              ],
              [
                "Renewal",
                "Checked on every refresh. Replaced once the certificate has less than the given number of days left, so an expiry never surprises anybody.",
              ],
              [
                "A failed renewal",
                "Reported, and the machine keeps the certificate it has. Losing a working certificate because a renewal failed would be worse than the renewal failing.",
              ],
            ]}
          />
          <Note>
            This is what makes EAP-TLS on the network practical: see{" "}
            <strong>Network access</strong>.
          </Note>
        </Section>

        <Section title="Trusting certificates this domain did not issue">
          <p>
            A domain trusts more than one authority in practice: an internal CA that predates
            ODM, a vendor appliance, the authority in front of some internal service.{" "}
            <strong>Certificates</strong> → <strong>Trusted</strong> holds them, and{" "}
            <strong>Publish to domain</strong> sends the whole trust store — this
            domain&rsquo;s own root and everything added there — to every member as one policy
            object.
          </p>
          <Reference
            headers={["Step", "What happens"]}
            rows={[
              [
                "Trust a certificate",
                "The PEM is parsed before it is stored, so the subject, expiry and whether it is an authority come from the certificate itself.",
              ],
              [
                "Publish to domain",
                "One policy object holds every trusted certificate, linked at the domain head. Agents install them into the system trust store.",
              ],
              [
                "Stop trusting",
                "Removes it from the next publish. Machines keep it until that policy reaches them, so publish afterwards.",
              ],
            ]}
          />
        </Section>

        <Section title="The root authority">
          <Reference
            headers={["Property", "Value"]}
            rows={[
              ["Key", "RSA 4096, written 0600 in the CA directory and never leaving it"],
              ["Validity", "10 years"],
              ["Constraint", "Signs leaf certificates only; no subordinate authorities"],
              ["Key usage", "Certificate signing and revocation-list signing"],
            ]}
          />
          <p>
            The authority is created once. Creating a second one over the first is refused; to
            replace it, remove the CA directory contents and create it again, then re-issue and
            re-publish.
          </p>
        </Section>

        <Section title="Profiles">
          <Reference
            headers={["Profile", "Extended key usage", "Use"]}
            rows={[
              ["Server", "TLS server authentication", "Web services, LDAP, SMB, anything a client connects to."],
              ["Client", "TLS client authentication", "Authenticating a user or machine to a service."],
              ["Console", "TLS server authentication", "Reserved for the administration console's own certificate."],
            ]}
          />
        </Section>

        <Section title="Issuing">
          <Reference
            headers={["Field", "Notes"]}
            rows={[
              ["Common name", "The primary name. Also added as a subject alternative name."],
              ["Additional names", "Host names or IP addresses, comma separated."],
              ["Validity", "Up to 1825 days. The default is 397."],
            ]}
          />
          <Note>
            The private key is generated at issuing time, returned once in the dialog, and never
            stored. If it is lost, issue a new certificate.
          </Note>
        </Section>

        <Section title="Distributing trust">
          <p>
            <strong>Publish to domain</strong> writes the root certificate into a policy object
            named <C>ODM Certificate Trust</C> and links it at the domain head. Agents install it
            into <C>/usr/local/share/ca-certificates</C> and rebuild the system trust bundle on
            their next refresh.
          </p>
          <p>
            The root can also be downloaded directly for machines outside the domain, or for
            browsers that keep their own store.
          </p>
        </Section>

        <Section title="Revocation">
          <p>
            Revoking marks a certificate revoked and adds it to the revocation list, which is
            published at <C>/api/v1/ca/crl</C> in PEM form. The list is signed by the authority and
            names every revoked serial.
          </p>
          <Note>
            Revocation only takes effect where relying parties actually check the list. Publish it
            somewhere they read, or issue short-lived certificates instead.
          </Note>
        </Section>

        <Section title="The console certificate">
          <p>
            Replacing the console certificate issues one with the console profile and installs it.
            The new material is staged where the control plane can write; a privileged helper
            verifies that the key matches the certificate and that the certificate is not already
            expired, keeps a copy of the previous pair, installs the new one, and restarts the
            service. The console is briefly unavailable.
          </p>
          <Note>
            Publish the root first. A browser that does not trust the authority will warn about the
            new certificate exactly as it warned about the self-signed one.
          </Note>
        </Section>

        <Section title="The first certificate">
          <p>
            Before any authority exists, the console uses a self-signed certificate created during
            bring-up.
          </p>
          <Code>{`sudo deploy/generate-self-signed.sh --fqdn odm.corp.example.internal`}</Code>
          <p>
            It is written to <C>/etc/odm/tls/api.crt</C> and <C>/etc/odm/tls/api.key</C>, and is
            not overwritten if one is already present.
          </p>
        </Section>

        <Section title="Expiry">
          <p>
            The Certificates page and the health dashboard both report certificates expiring within
            30 days, and the authority&rsquo;s own expiry date.
          </p>
        </Section>
      </Details>
    </>
  );
}
