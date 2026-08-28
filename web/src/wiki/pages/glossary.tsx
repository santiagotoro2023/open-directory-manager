import { Details, Quickstart, Reference, Section } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "glossary",
  title: "Glossary",
  section: "Reference",
  summary: "Terms used across the console, and how they map to Active Directory and FreeIPA.",
  keywords: ["terminology", "glossary", "vocabulary", "dn", "sid", "upn", "spn", "keytab"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          The console uses Active Directory terminology where it is the clearest term, and modern
          identity-management terminology where that reads better. This page maps them.
        </p>
        <Reference
          headers={["In ODM", "Active Directory", "Also known as"]}
          rows={[
            ["Host", "Computer object", "Machine, client, member"],
            ["User group", "Group holding user accounts", "Group"],
            ["Computer group", "Group holding computer accounts", "Host group"],
            ["HBAC rule", "Logon rights", "Host-based access control"],
            ["Sudo rule", "—", "Privilege escalation rule"],
            ["Organizational unit", "Organizational unit", "OU, container"],
            ["Group policy object", "Group policy object", "GPO, policy"],
            ["Delegation", "Delegation of control", "RBAC, role assignment"],
          ]}
        />
      </Quickstart>

      <Details>
        <Section title="Directory">
          <Reference
            headers={["Term", "Meaning"]}
            rows={[
              [
                "Distinguished name",
                "The full path identifying an object, for example CN=ada,OU=Sales,DC=corp,DC=example,DC=internal.",
              ],
              ["Relative distinguished name", "The leftmost component of a distinguished name."],
              ["Domain head", "The root of the domain, written as DC components."],
              ["Organizational unit", "A container. Policy links and delegation scopes attach to it."],
              ["Built-in container", "A container created with the domain, such as Users or Computers."],
              ["Security identifier", "The stable identifier a principal is known by. Access rules name it."],
              ["Account name", "The short logon name. A host account's ends with a dollar sign."],
              ["User principal name", "A logon name in e-mail form, such as ada@corp.example.internal."],
              ["Nesting", "A group holding another group. Membership follows through it."],
              ["User group", "A group that holds people. Used for sudo rules, HBAC rules, delegation and policy filtering."],
              ["Computer group", "A group that holds hosts. Used for policy filtering and item-level targeting."],
              ["Group scope", "Where a group can be used: global, domain local or universal."],
            ]}
          />
        </Section>

        <Section title="Policy">
          <Reference
            headers={["Term", "Meaning"]}
            rows={[
              ["Group policy object", "A named set of settings. Does nothing until linked."],
              ["Link", "The attachment between a policy object and a container."],
              ["Link order", "Precedence within one container. 1 is highest."],
              ["Enforced", "A link applied after every unenforced one, surviving blocked inheritance."],
              ["Block inheritance", "An organizational unit discarding policy linked above it."],
              ["Security filtering", "Restricting a policy object to named principals."],
              ["Item-level targeting", "Restricting by operating system, host name, group or address."],
              ["Effective policy", "The merged result of everything that applies to one object."],
              ["Resultant Set of Policy", "What should apply, and what a machine reported applying."],
              ["Policy serial", "A fingerprint of the effective policy, used to skip unchanged work."],
            ]}
          />
        </Section>

        <Section title="Kerberos and authentication">
          <Reference
            headers={["Term", "Meaning"]}
            rows={[
              ["Realm", "The Kerberos name of the domain, conventionally upper case."],
              ["Principal", "An identity Kerberos knows: a user, a host or a service."],
              ["Service principal name", "A service's principal, such as HTTP/odm.corp.example.internal."],
              ["Keytab", "A file holding a principal's long-term keys, used to authenticate without a password."],
              ["SPNEGO", "The mechanism that carries a Kerberos ticket over HTTP."],
              ["Ticket", "The credential a client presents to a service."],
            ]}
          />
        </Section>

        <Section title="Services">
          <Reference
            headers={["Term", "Meaning"]}
            rows={[
              ["SYSVOL", "The replicated share holding policy files."],
              ["Naming context", "One replicated partition of the directory."],
              ["Replication partnership", "A link between two controllers over which changes flow."],
              ["Scope", "A DHCP subnet with its pool and options."],
              ["Reservation", "A fixed address tied to a hardware address."],
              ["Failover pair", "Two DHCP nodes sharing lease state."],
              ["Dynamic update", "A DNS record written by a client or by the DHCP service."],
              ["Trust anchor", "A certificate a machine trusts to sign others."],
              ["Revocation list", "The signed list of certificates the authority has revoked."],
            ]}
          />
        </Section>

        <Section title="Delegation">
          <Reference
            headers={["Term", "Meaning"]}
            rows={[
              ["Permission", "One thing that can be done, such as user.write."],
              ["Role", "A named set of permissions."],
              ["Assignment", "A role granted to a principal at a scope."],
              ["Scope", "The distinguished name an assignment applies at, and beneath."],
              ["Domain administrator", "A member of the group the console is gated on. Holds everything."],
            ]}
          />
        </Section>
      </Details>
    </>
  );
}
