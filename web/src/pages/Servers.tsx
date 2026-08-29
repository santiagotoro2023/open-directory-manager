import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Server as ServerIcon } from "lucide-react";
import { ApiError, api, type ManagedServer } from "../api";
import { Modal } from "../components/Modal";
import { useContextMenu } from "../components/ContextMenu";

const ROLE_LABELS: Record<string, string> = {
  core: "Directory, Group Policy and DNS",
  dhcp: "DHCP",
  "certificate-authority": "Certificate authority",
  "file-server": "File server",
  pxe: "Client enrolment (PXE)",
};

function since(value: string | null): string {
  if (!value) return "never";
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 2) return "just now";
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

export function Servers() {
  const [servers, setServers] = useState<ManagedServer[]>([]);
  const [open, setOpen] = useState<ManagedServer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { bind, menu } = useContextMenu();

  const load = useCallback(async () => {
    setError(null);
    try {
      setServers((await api.servers.list()).servers);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="content">
      <div className="page-header">
        <h1>Servers</h1>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <table className="data">
        <thead>
          <tr>
            <th scope="col">Server</th>
            <th scope="col">Runs</th>
            <th scope="col">Operating system</th>
            <th scope="col">Agent</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((server) => (
            <tr
              key={server.distinguished_name}
              onClick={() => setOpen(server)}
              {...bind([
                { label: server.name, heading: true },
                { label: "Details…", onSelect: () => setOpen(server) },
              ])}
            >
              <td>
                <ServerIcon size={15} aria-hidden="true" />
                {server.name}
                {server.domain_controller && <span className="badge">controller</span>}
              </td>
              <td>
                {server.roles.length === 0
                  ? "—"
                  : server.roles
                      .map((role) => ROLE_LABELS[role.role] ?? role.role)
                      .join(", ")}
                {server.pending_tasks > 0 && (
                  <span className="badge">{server.pending_tasks} queued</span>
                )}
              </td>
              <td>{server.operating_system || "—"}</td>
              <td>{since(server.last_seen)}</td>
            </tr>
          ))}
          {servers.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                No machines have joined the domain yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {menu}

      {open && (
        <Modal
          title={open.name}
          submitLabel="Close"
          onClose={() => setOpen(null)}
          onSubmit={() => setOpen(null)}
        >
          <dl className="definition">
            <dt>Name</dt>
            <dd className="mono">{open.fqdn}</dd>
            <dt>Operating system</dt>
            <dd>{open.operating_system || "not reported"}</dd>
            <dt>Role in the domain</dt>
            <dd>{open.domain_controller ? "Domain controller" : "Member server"}</dd>
            <dt>Agent last reported</dt>
            <dd>{since(open.last_seen)}</dd>
            <dt>Queued work</dt>
            <dd>{open.pending_tasks === 0 ? "none" : `${open.pending_tasks} tasks`}</dd>
          </dl>

          <h3 className="section-title">Roles</h3>
          <table className="data compact">
            <tbody>
              {open.roles.map((role) => (
                <tr key={role.role}>
                  <td>{ROLE_LABELS[role.role] ?? role.role}</td>
                  <td>
                    <span className={`badge ${role.state === "active" ? "success" : ""}`}>
                      {role.state}
                    </span>
                  </td>
                </tr>
              ))}
              {open.roles.length === 0 && (
                <tr>
                  <td className="empty">Carries no roles. Add one under Server Roles.</td>
                </tr>
              )}
            </tbody>
          </table>
        </Modal>
      )}
    </main>
  );
}
