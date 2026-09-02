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
                '"Operation not permitted" from a package\u2019s own postinst',
                <>
                  Fixed: the agent&rsquo;s unit forbade a <C key="f">chmod</C> that sets the setgid
                  bit, and a service&rsquo;s restrictions are inherited by everything it starts.
                  Packages now install outside it. Upgrade the agent on that machine.
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
                'kea-ctrl-agent "start condition unmet"',
                <>
                  Fixed: Debian&rsquo;s unit carries{" "}
                  <C key="k">ConditionFileNotEmpty=/etc/kea/kea-api-password</C> and refuses to
                  start without that exact file. The DHCP role writes its Control Agent credential
                  there now.
                </>,
              ],
              [
                "Network boot and DHCP on the same machine",
                <>
                  Only one process can bind UDP 67, so dnsmasq cannot answer as a proxy DHCP server
                  beside Kea. Installing both on one machine now leaves dnsmasq serving TFTP alone
                  and puts <C key="n">next-server</C> and the boot files into Kea, which is what a
                  DHCP server and a boot server sharing a host have always had to do.
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

        <Section title="Policies that did not take">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                "The console shows no report for a machine",
                <>
                  Fixed: the appliers report five words and the control plane accepted three, so
                  one <C key="a">applied</C> made it refuse the whole report. Upgrade both.
                </>,
              ],
              [
                "A removed policy is still being enforced",
                <>
                  Fixed: taking a file away is a change to whatever reads it. Removing an HBAC
                  rule left sshd refusing a user with a rule that existed nowhere on disk; the
                  services that read a pruned file are reloaded now.
                </>,
              ],
              [
                'An HBAC rule for a group refused everyone',
                <>
                  Fixed, and worth knowing: a group is written <C key="b">%Engineers</C> —{" "}
                  <strong>Select…</strong> does that for you. A bare name is a user.
                </>,
              ],
              [
                "A printer handed out by policy never appeared",
                <>
                  The machine needs CUPS; without it the report says so rather than failing. It is
                  socket-activated on a desktop, and the agent starts it before adding a queue. A
                  printer is a user setting, so the queue appears when somebody signs in, not
                  before.
                </>,
              ],
              [
                "One printer is listed two or three times",
                <>
                  Fixed: a managed machine no longer answers DNS-SD and no longer lets
                  cups-browsed make queues of its own, and the print server no longer advertises
                  the queues it hands out. Both were copies of the printer the policy gave you,
                  under names nobody chose.
                </>,
              ],
              [
                "A mapped drive is nowhere in the file manager",
                <>
                  Fixed: drive maps are attached when somebody signs in, with their own ticket,
                  and added to the file manager&rsquo;s sidebar. Started by the machine they could
                  not authenticate at all &mdash; <C key="c">No such device</C> on every access.
                </>,
              ],
              [
                "A setting stayed after its policy object was unlinked",
                <>
                  Fixed. A file is pruned; so now are the things that are not files &mdash; a
                  printer queue, a mapped drive and its bookmark, a roaming profile, a login
                  banner in the greeter&rsquo;s compiled database.
                </>,
              ],
              [
                "Applications take minutes to open and settings do not save",
                <>
                  A roaming profile stored as a directory on SMB: dconf cannot rename its
                  database into place there, so everything that saves a setting fails and the
                  file manager never starts. Store the profile as a disk image, which is the
                  default.
                </>,
              ],
            ]}
          />
        </Section>

        <Section title="Remote desktop">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                <>
                  <C key="d">X server could not be started</C>
                </>,
                <>
                  Fixed, in three places: Debian only lets a console user start an X server and a
                  remote session has no console seat; a home directory made for somebody as root
                  is one their X server cannot write to; and a home under{" "}
                  <C key="e">/home/DOMAIN/name</C> was unreachable because the directory above it
                  was root&rsquo;s alone.
                </>,
              ],
              [
                <>
                  <C key="f">Can&rsquo;t create session for user</C>
                </>,
                <>
                  A profile disk that could not be attached used to fail the whole PAM session,
                  which stops everybody signing in rather than one person&rsquo;s profile
                  roaming. It falls back to a local home and says why in the journal. Check that
                  the collection&rsquo;s profile share exists and that the people using it may
                  write to it.
                </>,
              ],
              [
                "Nobody is balanced between hosts",
                <>
                  The broker owns 3389. A session host on the same machine moves to 3390; if both
                  wanted 3389, xrdp won and haproxy exited with{" "}
                  <C key="g">cannot bind socket</C>.
                </>,
              ],
            ]}
          />
        </Section>

        <Section title="Joining a client">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                '"Invalid configuration. Exiting..." from net ads join',
                <>
                  Fixed: Debian&rsquo;s <C key="s">smb.conf</C> says{" "}
                  <C key="t">server role = standalone server</C> and{" "}
                  <C key="u">net ads join</C> reads it first. The join writes one that says
                  the machine is a domain member. Use a client package from 0.3.2 or later.
                </>,
              ],
              [
                '"failed to find DC for domain"',
                <>
                  The machine cannot resolve the domain. A domain member uses the domain&rsquo;s
                  own DNS — normally handed out by DHCP. Pass{" "}
                  <C key="v">--server &lt;controller ip&gt;</C> and the join sets the resolver
                  itself.
                </>,
              ],
              [
                '"Unit odm-agent.service does not exist"',
                "Fixed: the agent and its unit are in the client package now. Reinstall it.",
              ],
              [
                '"certificate signed by unknown authority" after joining',
                <>
                  Until the domain has its own authority the console&rsquo;s certificate is
                  self-signed, so the client has nothing to check it against. Copy{" "}
                  <C key="w">/etc/odm/tls/api.crt</C> from the console and join with{" "}
                  <C key="x">--ca-cert</C>. Setup prints the two commands.
                </>,
              ],
              [
                "KDC_ERR_S_PRINCIPAL_UNKNOWN for HTTP/odm.<domain>",
                <>
                  Fixed: the console answers to <C key="y">odm.&lt;domain&gt;</C> as well as its
                  own name, and that principal is registered now. Re-run{" "}
                  <C key="z">deploy/create-api-service-account.sh</C> on a controller.
                </>,
              ],
            ]}
          />
        </Section>

        <Section title="Roles that will not settle">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                'A role sits at "installing" and nothing on the machine happens',
                <>
                  The agent installs a role; the control plane cannot run anything on a machine it
                  is not. If <strong>Progress</strong> never says the machine picked the work up,
                  the agent there is not collecting: <C key="ri">systemctl status odm-agent</C> and{" "}
                  <C key="rj">journalctl -u odm-agent -n 50</C> on that machine, then{" "}
                  <C key="rk">odm-agent apply --force</C> to make it check in at once.
                </>,
              ],
              [
                "A joined machine never reports, even after a reboot",
                <>
                  <C key="jn">sudo odm-agent check</C> on that machine names the step that fails,
                  and fixes the commonest one itself: the console&rsquo;s certificate, which the
                  machine fetches from the domain. If that step still fails, SYSVOL has no copy —
                  run <C key="jn2">deploy/publish-console-certificate.sh</C> on the controller —
                  or hand it over with <C key="jn3">sudo odm-agent trust /path/to/api.crt</C>.
                </>,
              ],
              [
                '"has never been heard from, so it is probably not running the agent"',
                <>
                  Correct if nothing at all has arrived from it. It used to appear over machines
                  checking in every fifteen minutes, because it was judged on the last run that
                  applied policy and policy already applied is not applied again &mdash; upgrade
                  the control plane. If it persists, the agent really is not reaching the console
                  from there.
                </>,
              ],
              [
                'A printer, tunnel or collection sits at "applying"',
                <>
                  Fixed: only three kinds of work ever wrote their outcome back, so a queue that
                  was created, an interface that was up and a broker that was balancing all
                  looked unfinished. Upgrade the control plane.
                </>,
              ],
              [
                "DHCP says the role is not installed",
                <>
                  The installer writes <C key="k">ODM_KEA_URL</C> and its credential into the
                  secrets file when the console is on that machine, and the console restarts half
                  a minute later to pick them up. On a separate node, add the three lines the
                  installer prints.
                </>,
              ],
              [
                "A DHCP scope disappears after a restart",
                <>
                  Fixed: Kea rewrites its own configuration to persist one, and both the file
                  ownership and its AppArmor profile refused. Re-run the DHCP role.
                </>,
              ],
              [
                "Remote desktop connects but never balances",
                <>
                  The broker owns 3389. A session host on the same machine is moved to 3390
                  automatically; before that they clashed and xrdp won, so every client reached
                  one host directly.
                </>,
              ],
            ]}
          />
        </Section>

        <Section title="Deleted objects">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                'Restore fails with "search failed: noSuchObject"',
                <>
                  Fixed, and it was every restore: the directory reports{" "}
                  <C key="r">noSuchObject</C> for a search whose base is not there, and the check
                  for whether the object is already back searches a name that by definition is not.
                  Upgrade the control plane.
                </>,
              ],
              [
                "The container it came from is gone",
                "Restore → Restore into → Select… puts it somewhere else. Nothing is unrestorable.",
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
                "A row reading WARNING / The option -k is deprecated",
                <>
                  Fixed: samba-tool writes that notice on standard output, next to the policy, and
                  it was read back as a line of it. The control plane passes{" "}
                  <C key="u">--use-kerberos=required</C> now.
                </>,
              ],
              [
                "A restored object came back with a new SID",
                <>
                  Restoring reanimates the directory&rsquo;s own tombstone, which needs the
                  Reanimate Tombstones right and access to the container tombstones live in.
                  Re-run <C key="r">deploy/create-api-service-account.sh</C> on a domain
                  controller and restart the control plane; a domain provisioned before this was
                  granted is the one that hits it.
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
                "No controller has reported its replication state yet",
                <>
                  Each controller collects it with its inventory, so it appears at that
                  controller&rsquo;s next check-in. If it never does, the agent there is not
                  running: <C key="e">systemctl status odm-agent</C> on that controller.
                </>,
              ],
              [
                "Replication said the account may not read replication state",
                <>
                  No right could have fixed that, and re-running the service-account script never
                  helped: Samba answers <C key="e2">samba-tool drs showrepl</C> only to a caller
                  that is itself a domain controller or an administrator. Each controller now
                  collects its own state as root, with the machine account Samba accepts. Upgrade
                  the control plane and the agents.
                </>,
              ],
              [
                "Only one domain controller is listed",
                "Controllers are read from their computer accounts. A second one appears once it has joined and replicated.",
              ],
              [
                "A client stops finding the domain after a reboot",
                <>
                  Fixed: the join pins the domain&rsquo;s DNS to the connection profile.
                  NetworkManager rewrites resolv.conf from DHCP on every boot, and resolvectl&rsquo;s
                  per-link settings are runtime state, so a machine configured either of those
                  ways left the domain at its first restart.
                </>,
              ],
              [
                <>
                  Setup stops at <C key="s">Could not get lock /var/lib/dpkg/lock-frontend</C>
                </>,
                <>
                  Fixed: a machine that booted a minute ago is usually still running its own
                  apt. Setup waits for the lock now instead of failing.
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
              [
                "A scope is listed as handing out no DNS server",
                <>
                  It has no <C key="dns">domain-name-servers</C> option. Clients on it get an
                  address and resolve nothing. Edit the scope and set the domain controllers.
                </>,
              ],
              [
                "The Leases tab is empty while a scope reports addresses in use",
                "Fixed in 0.6.0: the lease query asked for the leases in zero subnets. Upgrade the control plane.",
              ],
            ]}
          />
        </Section>

        <Section title="File shares">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                <>
                  &ldquo;Failed to mount Windows share: Invalid argument&rdquo;, or an immediate
                  failure with no password prompt
                </>,
                <>
                  The server&rsquo;s name did not resolve; libsmbclient reports a failed lookup as{" "}
                  <C key="e">EINVAL</C>. On the client:{" "}
                  <C key="f">getent hosts fs01.corp.example.internal</C>. Put the machine on the
                  domain&rsquo;s DHCP, or point its resolver at a controller.
                </>,
              ],
              [
                "The password is refused from a machine that is not joined",
                "Use the domain account's logon name. The domain field can be left as the client suggests.",
              ],
              [
                "The share opens but a folder inside it will not",
                "The access list. Add the group under the share's permissions with Read & write.",
              ],
              [
                "A share stays in applying",
                "The server's agent has not checked in, or the machine does not carry the file-server role.",
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
