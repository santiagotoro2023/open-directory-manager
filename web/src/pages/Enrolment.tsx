import { C } from "../wiki/components";
import { RoleConfiguration } from "../components/RoleConfiguration";

/**
 * Client enrolment: what a machine installed over the network gets.
 *
 * Installing the role puts a boot server on a machine. What that server hands
 * out — which Debian release, from which mirror, which domain and container
 * the machine joins — is configuration, and changing it should not mean
 * reinstalling anything.
 */
export function Enrolment() {
  return (
    <main className="content">
      <div className="page-header">
        <h1>Client Enrolment</h1>
      </div>

      <RoleConfiguration
        role="pxe"
        title="Unattended install"
        description="Applied by re-running the boot server's own installer, which rewrites the preseed and fetches the netboot image for the release chosen."
      />

      <h3 className="section-title">How a machine gets here</h3>
      <p className="muted">
        Network boot is advertised over DHCP, so a deployment reaches exactly the scopes chosen
        above and no others. That is what keeps a provisioning network separate from a client
        network on the same wire.
      </p>
      <ol className="wiki-steps">
        <li>It boots from the network, on one of the scopes chosen above.</li>
        <li>
          The boot server offers Debian&rsquo;s installer and points it at a preseed, so nothing
          is answered by hand.
        </li>
        <li>
          The installer partitions the disk, installs the release chosen above, and creates the
          local administrator account.
        </li>
        <li>
          On first boot it fetches <C>odm-client-install</C> from the boot server and joins the
          domain with the enrolment token, into the container set above.
        </li>
      </ol>

      <h3 className="section-title">Pinning a version</h3>
      <p className="muted">
        The default mirror installs whatever the release currently is, so a machine built today
        and one built next month differ. A <C>snapshot.debian.org</C> URL installs a fixed point
        release — for example{" "}
        <C>https://snapshot.debian.org/archive/debian/20250801T000000Z</C>.
      </p>
    </main>
  );
}
