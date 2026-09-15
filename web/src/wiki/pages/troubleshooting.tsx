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
              [
                <>
                  A client shows the new agent version, but a fix that version is supposed to
                  make has not happened; the agent logs only{" "}
                  <C key="nv1">policy unchanged</C>
                </>,
                <>
                  Fixed in 0.10.18. The apply that carries out a self-update runs under the old
                  binary; the new one then started, found the policy serial unchanged, and did
                  nothing until a policy object was next edited — so a release&rsquo;s fixes could
                  sit installed everywhere and applied nowhere. The agent now records which
                  version wrote the serial and applies once after every update. On an older
                  client, <C key="nv2">sudo odm-agent apply --force</C> does the same by hand.
                </>,
              ],
              [
                <>
                  A machine&rsquo;s inventory stopped updating, and the agent logs{" "}
                  <C key="inv1">422</C>{" "}
                  <C key="inv2">List should have at most 500 items</C>
                </>,
                <>
                  Fixed in 0.10.16. The control plane bounds every list in a check-in and rejects
                  the <em>whole</em> report when one is over, so a single long list cost the
                  machine everything it was reporting — inventory, sessions, disk health, even its
                  own agent version — and the console simply showed stale facts with no error
                  against the machine. Seen on a client with 530 pending updates against a limit
                  of 500. The agent now trims each list to what will be accepted before sending;
                  counts that matter (pending updates, security updates, package count) are
                  counted before the trim, so they stay accurate. Nothing to do but upgrade the
                  client — the next check-in is complete again.
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
                "Upgrade the agent on that machine. Packages are installed outside its own restrictions.",
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
                "Re-run the DHCP role. It writes the credential file the unit refuses to start without.",
              ],
              [
                "Network boot and DHCP on the same machine",
                "Only one process can bind UDP 67. Installing both on one machine leaves dnsmasq serving TFTP and puts next-server and the boot files into Kea.",
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
                "Upgrade the control plane and the agent.",
              ],
              [
                "A removed policy is still being enforced",
                "Upgrade the agent. It reloads whatever reads a file it has just pruned.",
              ],
              [
                'An HBAC rule for a group refused everyone',
                <>
                  A group is written <C key="b">%Engineers</C> &mdash;{" "}
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
                "Upgrade the agent and the print server. A managed machine makes no queues of its own.",
              ],
              [
                "A mapped drive is nowhere in the file manager",
                "Upgrade the agent. Drives are attached at sign-in, with the person’s own ticket.",
              ],
              [
                "A setting stayed after its policy object was unlinked",
                "Upgrade the agent.",
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
                  Re-run the session-host role on that machine, and check that the person’s
                  home directory is theirs to write to: an X server cannot start in a home
                  it does not own.
                </>,
              ],
              [
                <>
                  <C key="f">Can&rsquo;t create session for user</C>
                </>,
                <>
                  The profile disk could not be attached. Check the collection&rsquo;s profile
                  share exists and that the people using it may write to it; the reason is in the
                  journal under <C key="rp">odm-rd-profile</C>. With <strong>Allow local homes</strong>{" "}
                  the session gets a local home instead of being refused.
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
                "Use a client package from 0.3.2 or later.",
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
                "Reinstall the client package.",
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
                  Re-run <C key="z">deploy/create-api-service-account.sh</C> on a controller.
                </>,
              ],
            ]}
          />
        </Section>

        <Section title="A drive map that does not appear">
          <Reference
            headers={["Check", "How"]}
            rows={[
              [
                "What the session reported",
                <>
                  <strong>Directory</strong> &rarr; the person &rarr; <strong>Policy</strong>{" "}
                  &rarr; <strong>Last applied in a session</strong>. Every drive they were meant to
                  get is listed with what happened to it.
                </>,
              ],
              [
                "Are they in the group the entry names?",
                <>
                  The entry&rsquo;s <strong>For user or group</strong> is matched on the client
                  against the groups the machine resolves. <strong>Member of</strong> on their
                  account shows the nested ones too.
                </>,
              ],
              [
                '"Required key not available"',
                <>
                  The mount could not read their Kerberos ticket, because it is in the kernel
                  keyring or in KCM and the kernel&rsquo;s own helper looks for a file named by
                  uid. The agent repairs this itself now &mdash;{" "}
                  <C key="cc">krb5_ccname_template = FILE:/tmp/krb5cc_%U</C> in{" "}
                  <C key="cc2">sssd.conf</C> and <C key="cc3">default_ccache_name</C> in{" "}
                  <C key="cc4">krb5.conf</C>, then sssd is restarted &mdash; so it takes one more
                  sign-in: the ticket for a session already open is still in the old place.
                </>,
              ],
              [
                "The session has no ticket at all, on a machine that is joined and online",
                <>
                  Debian&rsquo;s <C key="ca">common-auth</C> runs pam_unix, then pam_winbind, then
                  pam_sss, and each success jumps over the rest &mdash; so pam_winbind answered the
                  login, asked the domain for no ticket, and SSSD never saw it. The agent removes
                  <C key="lpw"> libpam-winbind</C> where SSSD is behind it: this client&rsquo;s
                  identity and authentication are SSSD&rsquo;s, and winbind is not needed on it.
                </>,
              ],
              [
                '"has no Kerberos ticket in this session"',
                <>
                  <C key="kl">klist</C> in that session is empty: whichever PAM module
                  authenticated them did not ask the domain for a ticket, or the machine was
                  offline and they were let in from the cache. Check that{" "}
                  <C key="pa">/etc/pam.d/common-auth</C> runs <C key="ps">pam_sss</C>, and{" "}
                  <C key="ds">sssctl domain-status &lt;domain&gt;</C> for whether SSSD is online.
                  The agent configures pam_winbind to ask for one as well, since on a joined
                  Debian it is often the module that answers first.
                </>,
              ],
              [
                '"Permission denied" or "Bad address"',
                "The share's own permissions, or the machine has no ticket for it. klist in the session says whether there is one.",
              ],
              [
                'Nothing mounts, and the file server is not the domain controller',
                <>
                  Joining registers this machine&rsquo;s <C key="spn1">HOST/</C> service principal
                  name, which is what a Windows domain member needs &mdash; Windows quietly aliases
                  every other service to it. Linux&rsquo;s <C key="spn1b">cifs.upcall</C> carries no
                  such aliasing: a <C key="spn1c">sec=krb5</C> mount asks the KDC for the literal
                  principal <C key="spn1d">cifs/&lt;server&gt;</C>, and before 0.9.3 nothing ever
                  added that name, credentialed join or token enrolment alike. The KDC answers
                  &ldquo;Server not found in Kerberos database&rdquo; to every client asking for
                  one &mdash; the mount fails silently and the drive never reaches the sidebar,
                  while the share itself and its access list are perfectly correct. Upgrade to
                  0.9.3 or later, then re-run <C key="spn2">odm-client-install</C> on the file
                  server (with <C key="spn2b">--otp</C> or the admin credential, whichever it
                  joined with) to add the missing SPN and keytab entry to its existing account. A
                  domain controller is unaffected, since its account already carries every service
                  principal name from provisioning. On 0.9.3, restart{" "}
                  <C key="spn3">smbd</C> on the file server by hand afterwards &mdash; a rejoin
                  rewrites the keytab on disk but an already-running <C key="spn3b">smbd</C> keeps
                  the old one in memory until told otherwise; 0.9.4 does this restart itself.
                </>,
              ],
              [
                <>
                  A Kerberos ticket for <C key="nls1">cifs/&lt;server&gt;</C> is issued, but the
                  mount still fails, or <C key="nls2">smbclient -k</C> against the share answers{" "}
                  <C key="nls3">NT_STATUS_NO_LOGON_SERVERS</C>
                </>,
                <>
                  The file server&rsquo;s own log names this exactly:{" "}
                  <C key="nls4">journalctl -u smbd</C> there shows{" "}
                  <em>
                    generate_pac_session_info: winbindd not running - but required as domain
                    member
                  </em>
                  . smbd&rsquo;s Kerberos path calls into <C key="nls5">winbindd</C> to turn a
                  ticket&rsquo;s PAC into a session token on every domain member accepting a
                  connection, whatever else identity resolves through &mdash; SSSD doing
                  everything else on this machine does not make it optional. Before 0.9.5 the
                  file-server role never installed or started it. Upgrade to 0.9.5 or later and
                  reinstall the File Server role on that machine from Server Roles, which installs{" "}
                  <C key="nls6">winbind</C> and starts <C key="nls7">winbindd</C> alongside{" "}
                  <C key="nls8">smbd</C>; then re-run <C key="nls9">odm-client-install</C> to
                  rewrite <C key="nls10">smb.conf</C> with the matching{" "}
                  <C key="nls11">idmap config</C>, which keeps the uid winbindd computes for a SID
                  the same one SSSD already gave it &mdash; the one a share&rsquo;s access list
                  was written against.
                </>,
              ],
              [
                <>
                  0.9.5 is installed, <C key="wc1">idmap config</C> is really in{" "}
                  <C key="wc2">smb.conf</C>, but the share still answers{" "}
                  <C key="wc3">NT_STATUS_ACCESS_DENIED</C> and{" "}
                  <C key="wc4">wbinfo --user-groups</C> on the file server still fails with{" "}
                  <C key="wc5">WBC_ERR_DOMAIN_NOT_FOUND</C>
                </>,
                <>
                  A stale entry in winbindd&rsquo;s own on-disk idmap cache, left over from
                  whatever tried to resolve that account before idmap config existed &mdash;
                  winbindd cached the failure and keeps serving it back, and restarting the
                  service does not clear a cache that lives on disk. On the file server:{" "}
                  <C key="wc6">net cache flush</C>, or stop winbindd and delete{" "}
                  <C key="wc7">/var/lib/samba/winbindd_cache.tdb</C> directly, then start it
                  again. <C key="wc8">wbinfo -i DOMAIN\username</C> afterwards should show the
                  same uid <C key="wc9">getent passwd username</C> does; if it still does not,
                  the domain name in <C key="wc10">idmap config</C> does not match the workgroup
                  smbd actually joined with &mdash; <C key="wc11">testparm -s</C> shows both.
                </>,
              ],
              [
                "Nothing at all was reported",
                <>
                  The session hook did not run. <C key="ph">grep odm /etc/pam.d/common-session</C>{" "}
                  on the machine, and <C key="ph2">journalctl -t odm-profile -b</C> for what it
                  said.
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
                  Correct if nothing at all has arrived from it. Otherwise upgrade the
                  control plane and the agent, then read{" "}
                  <C key="hb">journalctl -u odm-agent</C> on the machine.
                </>,
              ],
              [
                'A printer, tunnel or collection sits at "applying"',
                "Upgrade the control plane.",
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
                "Re-run the DHCP role.",
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
                "Upgrade the control plane.",
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
                "Upgrade the control plane.",
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
                "Upgrade the control plane.",
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
                "Re-join with a current client package: it pins the domain’s DNS to the connection profile, which survives a reboot.",
              ],
              [
                <>
                  Setup stops at <C key="s">Could not get lock /var/lib/dpkg/lock-frontend</C>
                </>,
                "The machine is still running its own apt. Wait, or upgrade — setup waits for the lock.",
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
                "Upgrade the control plane.",
              ],
              [
                "A machine's own record still answers to an address it no longer has",
                <>
                  Before 0.9.7 a domain member never registered its own DNS record at all — it
                  only ever got one from provisioning, DHCP, or an operator typing it in by hand,
                  and a static re-address left that record answering for the old address until
                  someone fixed it themselves. Upgrade the machine and re-run{" "}
                  <C key="dd1">odm-client-install</C> (or reboot it, or{" "}
                  <C key="dd2">systemctl restart sssd</C>) to have it register itself the first
                  time; every pass after that keeps it current on its own, and its agent asks for
                  an immediate re-registration the moment its own reported address changes rather
                  than waiting on sssd's periodic refresh.
                </>,
              ],
              [
                "Deleting a zone did nothing, or there was no way to",
                "Upgrade the control plane; before 0.9.7 zone deletion always failed with “no such option: --force” before samba-tool touched the zone, and there was no delete action in the console to hit it with in the first place. Right-click the zone in DNS to delete it now.",
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

        <Section title="Boot splash">
          <Reference
            headers={["Symptom", "Check"]}
            rows={[
              [
                <>
                  The agent reports success, but the machine still shows GRUB for a moment and
                  kernel/systemd text instead of the spinner, from the very start of boot
                </>,
                <>
                  Check <C key="bs2">grep -E &apos;amdgpu|i915|radeon|nouveau&apos;
                  /etc/initramfs-tools/modules</C> lists the open-source display drivers — these
                  are what give early graphics on real hardware, and the kernel&rsquo;s own generic{" "}
                  <C key="bs3">simpledrm</C>/<C key="bs4">efifb</C> driver (backed by{" "}
                  <C key="bs5">GRUB_GFXPAYLOAD_LINUX=keep</C> in the drop-in file) is what actually
                  gives Plymouth a framebuffer to draw on for the rest, on any vendor&rsquo;s
                  hardware, without any GPU driver needing to load early at all. Two earlier
                  versions instead added an NVIDIA-specific kernel parameter for this
                  (<C key="bs6">nvidia-drm.modeset=1</C>, later{" "}
                  <C key="bs7">nvidia_drm.fbdev=1</C> alongside it) — both were removed after being
                  confirmed live to cause a different, worse problem on real NVIDIA hardware (see
                  the row below on nothing rendering at all). Upgrade to 0.10.12 or later; a
                  machine still on an older agent version may still carry one of those parameters
                  in its grub drop-in, which does no harm on its own but is no longer written by
                  current policy.
                </>,
              ],
              [
                <>
                  The machine no longer boots at all: it drops straight to an{" "}
                  <C key="bsx1">(initramfs)</C> busybox prompt on every boot, with no GRUB menu,
                  no login screen, nothing
                </>,
                <>
                  0.10.2 gave early graphics on non-NVIDIA hardware by widening{" "}
                  <C key="bsx2">MODULES=</C> in <C key="bsx3">/etc/initramfs-tools/initramfs.conf</C>{" "}
                  to <C key="bsx4">most</C>, which pulls in every module for every class of
                  hardware the kernel knows about, not just display drivers. On a machine with a
                  small <C key="bsx5">/boot</C> partition and more than one kernel already
                  installed, the rebuilt initramfs could be too big to fit, leaving a truncated
                  image that can never mount root again — this is exactly that symptom. 0.10.3
                  removes the <C key="bsx6">MODULES=most</C> widening entirely (naming the
                  handful of actual display drivers instead) and refuses to start a rebuild at
                  all when <C key="bsx7">/boot</C> is low on free space. 0.10.4 goes further: every
                  rebuild now backs up the running kernel&rsquo;s own initrd first, verifies the new
                  one actually lists cleanly with <C key="bsx13">lsinitramfs</C> afterward, and
                  automatically restores the backup and reports the setting as failed — never as
                  applied — if that check fails, whatever the underlying cause. A machine already
                  stuck at the <C key="bsx8">(initramfs)</C> prompt needs to be booted from rescue
                  media to free up <C key="bsx9">/boot</C> (remove old kernels with{" "}
                  <C key="bsx10">apt autoremove</C>, or delete an old{" "}
                  <C key="bsx11">initrd.img-*</C> for a kernel that is no longer installed) and
                  run <C key="bsx12">update-initramfs -u</C> by hand — this cannot be fixed
                  remotely once a machine is in this state, since the agent itself cannot run
                  without a bootable system underneath it. Before re-applying the policy fleet-wide,
                  update every machine&rsquo;s agent to 0.10.5 or later first, otherwise a machine
                  still on an older agent version can hit this again the next time it polls a
                  boot-splash policy with a change to apply.
                  <br />
                  <br />
                  <strong>0.10.4&rsquo;s own fix was not the end of it.</strong> Its validation —
                  the new initrd has to list cleanly with <C key="bsx13b">lsinitramfs</C> — caught a
                  corrupt archive, but a clean, valid archive can still be missing the one driver a
                  specific machine actually needs to find its own root filesystem, and nothing about
                  a clean listing proves that driver is in it. That is exactly what happened next: an
                  initrd that passed validation and still could not mount an NVMe root, because the
                  display-driver module list was detected per machine but storage was left to{" "}
                  <C key="bsx13c">MODULES=dep</C>&rsquo;s own auto-detection, untested against the
                  case that actually mattered. 0.10.5 stops trying to detect the right storage driver
                  per machine at all — a fixed, generous list (<C key="bsx13d">nvme</C>,{" "}
                  <C key="bsx13e">ahci</C>, <C key="bsx13f">virtio_blk</C>,{" "}
                  <C key="bsx13g">virtio_scsi</C>, and the rest of the common real and virtualised
                  disk transports) is now always included, the same reasoning as the display-driver
                  list but aimed at the category of driver that actually has to work for a boot to
                  succeed at all. It also stops treating a hidden, zero-second GRUB menu as
                  acceptable: a splash now always leaves at least two seconds where any keypress
                  still reaches the real menu, and reports an advisory (not a failure — it is a
                  legitimate choice) when only one kernel is installed, since a menu with nothing
                  else in it is not actually a way back. That combination — a generous module list,
                  a reachable menu, and a genuine fallback kernel — is the real safety net; the
                  validation check is one useful layer on top of it, never the guarantee by itself.
                  <br />
                  <br />
                  <strong>0.10.5&rsquo;s generous module list still was not enough</strong> — the
                  very next real rollout produced the exact same &ldquo;gave up waiting for root
                  file system&rdquo; failure, on a machine whose keyboard did not even respond at
                  the rescue prompt afterward. The actual cause was never which modules were listed:{" "}
                  <C key="sbx1">odm-agent.service</C> deliberately sets{" "}
                  <C key="sbx2">ProtectKernelModules=true</C>, and that hardening is inherited by
                  anything the agent spawns as a direct child — including{" "}
                  <C key="sbx3">update-initramfs</C>, triggered here through{" "}
                  <C key="sbx4">plymouth-set-default-theme -R</C>. That hid{" "}
                  <C key="sbx5">/usr/lib/modules</C> from the rebuild entirely, so every module this
                  file correctly listed was silently absent from the actual result regardless, on
                  every rebuild the agent itself triggered — while a manual rebuild from rescue
                  media, outside any such sandbox, always worked, which is what made this look like
                  a hardware problem rather than a process one for as long as it did.{" "}
                  <C key="sbx6">lsinitramfs</C> still reported the result as a structurally valid
                  archive throughout, since an archive missing files it should have had is not
                  itself a corrupt one. 0.10.9 routes the rebuild (and the plymouth package install)
                  through <C key="sbx7">Unsandboxed</C>, the same escape hatch this project already
                  uses for package installs for exactly this reason, and adds basic keyboard modules
                  (<C key="sbx8">usbhid</C>, <C key="sbx9">hid_generic</C>,{" "}
                  <C key="sbx10">i8042</C>, <C key="sbx11">atkbd</C>) to the same unconditional list
                  as the storage drivers, confirmed necessary live on the same machine.
                  <br />
                  <br />
                  <strong>When cleaning up an old kernel&rsquo;s files by hand under rescue
                  media, delete only what belongs to a version{" "}
                  <C key="bsx14">dpkg -l | grep linux-image</C> no longer lists.</strong>{" "}
                  A wildcard like <C key="bsx15">rm -rf vmlinuz-*</C> or{" "}
                  <C key="bsx16">rm -rf initrd.img-*</C> deletes the kernel binaries and
                  initrds for every installed kernel at once, including the one you are trying to
                  boot — a strictly worse state than the one you started rescuing, since GRUB then
                  has nothing to load at all rather than a bad initrd. If that already happened
                  and the exact matching kernel package cannot be reinstalled (no cached{" "}
                  <C key="bsx17">.deb</C> and no working network), <C key="bsx18">vmlinuz</C>,{" "}
                  <C key="bsx19">config</C> and <C key="bsx20">System.map</C> for a given kernel
                  version and architecture are byte-identical across every machine that installed
                  the same package — copying them from another machine on the same release
                  (matched by <C key="bsx21">uname -r</C>) works, and only{" "}
                  <C key="bsx22">initrd.img</C> itself needs to be built locally with{" "}
                  <C key="bsx23">update-initramfs -c -k &lt;version&gt;</C>, since it is specific to
                  that machine&rsquo;s own hardware and module set.
                </>,
              ],
              [
                "The spinner shows, but a background or logo does not appear",
                <>
                  <C key="bs4">plymouth-set-default-theme</C> with no arguments should print{" "}
                  <C key="bs5">odm-boot</C>; if it prints something else, the theme was never set
                  as the machine&rsquo;s default and the agent report for{" "}
                  <C key="bs6">grub:splash</C> says why. If it does say{" "}
                  <C key="bs7">odm-boot</C>, check the picture actually made it into the current
                  initramfs: <C key="bs8">lsinitramfs /boot/initrd.img-$(uname -r) | grep
                  odm-boot</C> should list <C key="bs9">background.png</C> or{" "}
                  <C key="bs10">watermark.png</C>. If it is missing there but present under{" "}
                  <C key="bs11">/usr/share/plymouth/themes/odm-boot/</C>, the initramfs was never
                  rebuilt after the picture was set — re-apply the policy, which rebuilds it
                  whenever a picture actually changes.
                </>,
              ],
              [
                <>
                  On an older agent version (0.10.2&ndash;0.10.13): nothing at all appears — no
                  spinner, no background, no logo, no message — but boot text is correctly
                  suppressed and the machine reaches login normally (NVIDIA)
                </>,
                <>
                  This took three rounds to actually root-cause, all on the same real NVIDIA
                  hardware. First, <C key="fbd2">nvidia-drm.modeset=1</C> alone: the agent&rsquo;s
                  own report showed a clean success and the theme files were correctly present and
                  validated in the rebuilt initramfs, and still nothing rendered. Adding{" "}
                  <C key="fbd3">nvidia_drm.fbdev=1</C> alongside it (0.10.11, on the theory that
                  DRM mode-setting alone was not giving Plymouth&rsquo;s renderer a usable
                  framebuffer) did not fix it either — <C key="fbd5">cat /proc/cmdline</C> confirmed
                  both parameters were genuinely active, and it still rendered nothing. The actual
                  cause, found from <C key="fbd6">journalctl -b -k | grep -B2 -A30 "Comm:
                  plymouthd"</C>: a real, reproducible kernel <C key="fbd7">WARN_ON</C> inside
                  NVIDIA&rsquo;s own <C key="fbd8">nvidia_drm.ko</C> (
                  <C key="fbd9">nv_drm_revoke_modeset_permission</C>), hit every time{" "}
                  <C key="fbd10">plymouthd</C> drops DRM master to hand the display to the login
                  manager — confirmed to have no module parameter (
                  <C key="fbd11">/sys/module/nvidia_drm/parameters/</C> only exposes{" "}
                  <C key="fbd12">modeset</C> and <C key="fbd13">fbdev</C>, nothing for this) and no
                  different driver version available in Debian&rsquo;s own repos, including
                  backports, to work around.
                  <br />
                  <br />
                  <strong>
                    None of that was the actual cause, and neither were the parameters.
                  </strong>{" "}
                  Removing the NVIDIA parameters entirely (0.10.12) and putting{" "}
                  <C key="nvx1">modeset=1</C> back alone (0.10.13) each rendered nothing too — four
                  attempts, four different parameter combinations, one identical result. The
                  constant across all of them: this agent&rsquo;s own display-driver list named{" "}
                  <C key="nvx2">nouveau</C> unconditionally, so every rebuilt initramfs
                  force-loaded the in-tree NVIDIA driver onto a machine running the proprietary
                  one. The two claim the same hardware; nouveau&rsquo;s probe calls{" "}
                  <C key="nvx3">drm_aperture_remove_conflicting_pci_framebuffers()</C> before
                  anything else — evicting <C key="nvx4">simpledrm</C>/<C key="nvx5">efifb</C> from
                  the display — and then fails on hardware it has no firmware for, leaving nothing
                  for Plymouth to draw on whatever its parameters said. A{" "}
                  <C key="nvx6">blacklist</C> does not prevent it either: a blacklist only blocks
                  automatic loading by modalias, while initramfs-tools runs an explicit{" "}
                  <C key="nvx7">modprobe</C> for every name in{" "}
                  <C key="nvx8">/etc/initramfs-tools/modules</C>. 0.10.14 removes that name on
                  proprietary-driver machines (including taking it back off machines an earlier
                  agent already wrote it to — every version before only ever appended to that
                  file), adds <C key="nvx9">nvidia_uvm</C> to the module set, and writes{" "}
                  <C key="nvx10">options nvidia-drm modeset=1 fbdev=1</C> to{" "}
                  <C key="nvx11">/etc/modprobe.d/</C>, which <C key="nvx12">mkinitramfs</C> copies
                  into the initramfs so it applies where the driver actually loads.
                  <br />
                  <br />
                  <strong>
                    None of that was it either. The answer came from Plymouth&rsquo;s own debug
                    log, and it is a Plymouth setting, not a driver problem.
                  </strong>{" "}
                  Capture it with <C key="pdt1">plymouth.debug=file:/run/plymouth-debug.log</C> on
                  the kernel command line. On the machine this kept failing on it read: {" "}
                  <C key="pdt2">Device timeout is set to 8.000000</C>, then{" "}
                  <C key="pdt3">got add event for device /dev/fb0</C> followed immediately by{" "}
                  <C key="pdt4">ignoring since we only handle subsystem graphics devices after
                  timeout</C>, then an attempt on <C key="pdt5">/dev/dri/renderD128</C> —
                  nvidia&rsquo;s <em>render node</em>, which has no modesetting at all, so{" "}
                  <C key="pdt6">Could not get card resources</C> was the only possible outcome —
                  and finally <C key="pdt7">got remove event for device /dev/fb0</C> as nvidia took
                  the display. Plymouth claims a real DRM device as soon as it sees one, but will
                  not claim a legacy <C key="pdt8">/dev/fb</C> framebuffer until{" "}
                  <C key="pdt9">DeviceTimeout</C> (eight seconds by default) has elapsed, so a
                  slow-probing GPU driver does not lose to a fallback. On a machine whose only
                  early graphics device <em>is</em> a legacy framebuffer — no{" "}
                  <C key="pdt10">simpledrm</C>, and the proprietary driver deliberately kept out of
                  the initramfs — that rule leaves the splash with nothing to draw on for the
                  entire window it exists to fill. 0.10.17 writes a short{" "}
                  <C key="pdt11">DeviceTimeout</C> into{" "}
                  <C key="pdt12">/etc/plymouth/plymouthd.conf</C> on machines with that driver, and
                  keeps the nvidia modules out of the initramfs so the firmware framebuffer
                  survives early boot. Upgrade to 0.10.17 or later and re-apply — not 0.10.15 or
                  0.10.16, for the reason in the next row.
                </>,
              ],
              [
                <>
                  On 0.10.15 or 0.10.16: still a text console, and{" "}
                  <C key="pdz1">systemctl status plymouth-start.service</C> shows{" "}
                  <C key="pdz2">Result: core-dump</C>, <C key="pdz3">signal=ABRT</C>
                </>,
                <>
                  Those two versions wrote <C key="pdz4">DeviceTimeout=0</C>, on the reasoning
                  that zero would mean &ldquo;use what you have&rdquo;. It does not. Plymouth arms
                  that wait with a call whose first lines are{" "}
                  <C key="pdz5">assert (seconds &gt; 0.0)</C>{" "}
                  (<C key="pdz6">src/libply/ply-event-loop.c</C>, the same in Debian 12&rsquo;s
                  22.02 and Debian 13&rsquo;s 24.004), so plymouthd aborted about a millisecond
                  after starting — in the initramfs, and then again when{" "}
                  <C key="pdz7">plymouth-start.service</C> retried from the root filesystem — on
                  every boot. Found by installing <C key="pdz8">systemd-coredump</C> and reading{" "}
                  <C key="pdz9">coredumpctl info plymouthd</C>: the backtrace is{" "}
                  <C key="pdz10">main &rarr; libply &rarr; abort</C>, and Plymouth&rsquo;s own debug
                  log ends on the trace line immediately before that call. The theme itself was
                  never at fault: run by hand on a text console (
                  <C key="pdz11">plymouthd --no-daemon --debug --mode=boot</C>, then{" "}
                  <C key="pdz12">plymouth show-splash</C>) it renders. 0.10.17 writes a positive
                  value and replaces a zero an earlier agent left; upgrade and re-apply.
                </>,
              ],
              [
                <>
                  An apply reports success, but says <C key="pr1">removed:</C>{" "}
                  <C key="pr2">/etc/plymouth/plymouthd.conf</C>,{" "}
                  <C key="pr3">/etc/initramfs-tools/modules</C> or{" "}
                  <C key="pr4">/etc/modprobe.d/odm-nvidia-drm.conf</C> — and the boot splash stops
                  working again every other refresh
                </>,
                <>
                  Fixed in 0.10.16, and worth understanding because it silently undid several of
                  the fixes above. The agent records which files it wrote, and at the end of every
                  apply it deletes anything the <em>previous</em> apply wrote that this one did
                  not — that is how removing a setting from a GPO removes the file it produced.
                  The appliers for these three files check whether the contents are already
                  correct and skip the write when they are, which is ordinarily good manners. Put
                  together, the second consecutive apply of an <em>unchanged</em> policy wrote
                  nothing, therefore claimed nothing, and deleted all three: the Plymouth
                  configuration, the NVIDIA module options, and the machine&rsquo;s entire
                  storage- and input-driver list. The next rebuild then produced an initramfs with
                  no NVMe, no virtio and no keyboard driver in it. Latent since 0.10.3.
                  <br />
                  <br />
                  The same mechanism had a worse case that had not fired yet: a rebuild that failed
                  validation and was correctly rolled back wrote{" "}
                  <C key="pr5">/boot/initrd.img-&lt;version&gt;</C> through the same call, claiming
                  the running kernel&rsquo;s initramfs — so the next routine fifteen-minute poll,
                  with no reason to write it again, would have deleted it outright. 0.10.16 makes
                  files the system owns, the pre-rebuild rollback image, and everything under{" "}
                  <C key="pr6">/boot</C> impossible to prune at all, and checks that on the way in{" "}
                  <em>and</em> on the way out — a machine upgrading from an earlier agent carries
                  the stale claim in the state file already on its disk, which on its own is
                  enough to delete the file once, on the very upgrade that fixes this. Upgrade to
                  0.10.16 and re-apply; a machine that already lost these files has them written
                  back by that apply.
                </>,
              ],
              [
                <>
                  A boot-splash logo or background was uploaded and saved, but reopening the
                  setting later shows &ldquo;No logo chosen&rdquo; / &ldquo;No background
                  chosen&rdquo; again — the picture is simply gone
                </>,
                <>
                  Fixed in 0.10.6: before then, the file picker marked a picture as
                  &ldquo;chosen&rdquo; the instant a file was selected, while the actual work —
                  decoding it and re-encoding it as PNG (see the row above) — was still running in
                  the background. Clicking Save before that finished, easy to do on a large
                  picture, persisted the setting without the image it looked like it had just
                  received. 0.10.6&rsquo;s console actually waits for a picture to finish reading
                  before Save can be clicked at all (the button reads &ldquo;Reading
                  file&hellip;&rdquo; and is disabled meanwhile). This only prevents the race going
                  forward — a setting already saved empty by it needs the picture uploaded again.
                </>,
              ],
              [
                "0.10.6 upgraded, but no picture upload works at all anymore — nothing happens after choosing a file",
                <>
                  0.10.6&rsquo;s own PNG conversion used <C key="csp1">URL.createObjectURL</C>, a{" "}
                  <C key="csp2">blob:</C> URL — and the console&rsquo;s Content-Security-Policy
                  (<C key="csp3">api/odm/security.py</C>) sets <C key="csp4">img-src</C> to{" "}
                  <C key="csp5">&apos;self&apos; data:</C> deliberately, with no{" "}
                  <C key="csp6">blob:</C>. The browser silently refused to load the picture under
                  that policy, so every conversion failed the same way on every upload, with
                  nothing shown to explain why. 0.10.7 reads the file as a{" "}
                  <C key="csp7">data:</C> URL instead — already explicitly allowed — rather than
                  loosen the policy, and a failure here is no longer silent: it now shows in the
                  file picker&rsquo;s own label where the file name would otherwise appear.
                </>,
              ],
              [
                <>
                  Saving after choosing a background or logo fails with{" "}
                  <C key="sz1">String should have at most 8000000 characters</C>
                </>,
                <>
                  A large photographic picture (a &ldquo;4K wallpaper&rdquo; background is exactly
                  the case this showed up on) re-encoded as lossless PNG can be many times its
                  original, lossy-compressed size — easily past the{" "}
                  <C key="sz2">splash_background</C>/<C key="sz3">splash_image</C> length limit a
                  GPO&rsquo;s stored settings enforce. Since Plymouth scales whatever it is given
                  down to the boot framebuffer&rsquo;s own resolution anyway, uploading it at full
                  resolution never bought anything to begin with. 0.10.8 downscales to at most
                  1920 pixels on the longest side before encoding, and halves further, up to a
                  few times, if the result is still too large — this should succeed for any
                  ordinary photo. If it still fails after that, the picture is being rejected as
                  genuinely too large to store even scaled down; try a smaller or simpler one.
                </>,
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
