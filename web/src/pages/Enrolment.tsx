import { InfoPanel } from "../components/DocsLink";
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

      <InfoPanel page="client-enrolment">
        A machine that boots from the network installs Debian unattended and joins the domain on
        first boot. These settings are what it installs and where it lands; boot is offered only on
        the networks ticked below.
      </InfoPanel>

      <RoleConfiguration
        role="pxe"
        title="Unattended install"
        description="Applied by re-running the boot server's own installer, which rewrites the preseed and fetches the netboot image for the release chosen."
      />
    </main>
  );
}
