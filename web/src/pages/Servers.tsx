import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Server as ServerIcon } from "lucide-react";
import { ApiError, api, type ComputerAction, type ManagedServer } from "../api";
import { Modal } from "../components/Modal";
import { useContextMenu } from "../components/ContextMenu";

const BULK_LABELS: Record<string, string> = {
  "update-check": "Check for updates",
  "update-install": "Install updates",
  "policy-refresh": "Re-apply policy",
  restart: "Restart",
  shutdown: "Shut down",
};

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
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<ComputerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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

      {/* The same request, asked of several machines at once. Each is
          authorised on its own, so a scope that reaches some and not the rest
          does the part it may and says what it skipped. */}
      {chosen.size > 0 && (
        <div className="selection-bar">
          <span className="count">{chosen.size} selected</span>
          <button type="button" className="ghost" onClick={() => setBulk("update-check")}>
            Check for updates
          </button>
          <button type="button" className="ghost" onClick={() => setBulk("update-install")}>
            Install updates
          </button>
          <button type="button" className="ghost" onClick={() => setBulk("policy-refresh")}>
            Re-apply policy
          </button>
          <button type="button" className="danger" onClick={() => setBulk("restart")}>
            Restart
          </button>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={() => setChosen(new Set())}>
            Clear
          </button>
        </div>
      )}

      {notice && <p className="muted">{notice}</p>}

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <table className="data">
        <thead>
          <tr>
            <th scope="col" style={{ width: "44px" }}>
              <span className="sr-only">Select</span>
            </th>
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
              <td onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`Select ${server.name}`}
                  checked={chosen.has(server.distinguished_name)}
                  onChange={(event) =>
                    setChosen((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(server.distinguished_name);
                      else next.delete(server.distinguished_name);
                      return next;
                    })
                  }
                />
              </td>
              <td>
                <ServerIcon size={15} aria-hidden="true" />
                {server.name}
                {server.domain_controller && <span className="badge">controller</span>}
              </td>
              <td>
                {server.roles.length === 0
                  ? "—"
                  : server.roles.map((role) => ROLE_LABELS[role.role] ?? role.role).join(", ")}
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
              <td colSpan={5} className="empty">
                No machines have joined the domain yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {menu}

      {bulk && (
        <Modal
          title={`${BULK_LABELS[bulk]} on ${chosen.size} machines?`}
          submitLabel={BULK_LABELS[bulk]}
          onClose={() => setBulk(null)}
          onSubmit={async () => {
            const action = bulk;
            setBulk(null);
            try {
              const result = await api.servers.bulkAction([...chosen], action);
              setNotice(
                `Queued on ${result.queued.length}` +
                  (result.skipped.length
                    ? `; skipped ${result.skipped.length} (${result.skipped
                        .map((entry) => entry.reason)
                        .filter((value, index, all) => all.indexOf(value) === index)
                        .join(", ")})`
                    : ""),
              );
              setChosen(new Set());
              void load();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : String(err));
            }
          }}
        >
          <p>
            {BULK_LABELS[bulk]} runs on each machine at its next check-in, or immediately with{" "}
            odm-agent apply --force on it.
          </p>
          {(bulk === "restart" || bulk === "shutdown") && (
            <p className="alert" role="alert">
              Anyone signed in to those machines loses their session.
            </p>
          )}
        </Modal>
      )}

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
