import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Server as ServerIcon } from "lucide-react";
import { ApiError, api, type ControllerOverview } from "../api";
import { Field, Modal } from "../components/Modal";

function since(value: string | null): string {
  if (!value) return "never";
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 2) return "just now";
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * The controllers that hold the directory.
 *
 * Whether a controller is read-only is decided when it joins the domain and
 * cannot be changed afterwards — in Samba or in Windows. So this reports what
 * each one is and produces the command that adds another, rather than offering
 * a switch that could not do what it says.
 */
export function Controllers() {
  const [overview, setOverview] = useState<ControllerOverview | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOverview(await api.controllers.list());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replication = overview?.replication;

  return (
    <main className="content">
      <div className="page-header">
        <h1>Domain Controllers</h1>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
          Refresh
        </button>
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          Add a controller
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
            <th scope="col">Controller</th>
            <th scope="col">Holds</th>
            <th scope="col">Operating system</th>
            <th scope="col">Agent</th>
          </tr>
        </thead>
        <tbody>
          {(overview?.controllers ?? []).map((controller) => (
            <tr key={controller.distinguished_name}>
              <td>
                <ServerIcon size={15} aria-hidden="true" />
                {controller.name}
              </td>
              <td>
                {controller.read_only ? (
                  <span className="badge">read-only</span>
                ) : (
                  <span className="badge success">writable</span>
                )}
              </td>
              <td>{controller.operating_system || "—"}</td>
              <td>{since(controller.last_seen)}</td>
            </tr>
          ))}
          {overview?.controllers.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                No controllers found. That should not be possible from here.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">Replication</h3>
      {replication?.available === false ? (
        <p className="muted">{replication.detail}</p>
      ) : (
        <>
          <p>
            <span className={`badge ${replication?.healthy ? "success" : "failure"}`}>
              {replication?.healthy ? "in step" : "attention needed"}
            </span>
          </p>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Partition</th>
                <th scope="col">From</th>
                <th scope="col">Last attempt</th>
                <th scope="col">Failures</th>
              </tr>
            </thead>
            <tbody>
              {(replication?.inbound ?? []).map((entry, index) => (
                <tr key={index}>
                  <td className="mono">{entry.naming_context}</td>
                  <td className="mono">{entry.partner}</td>
                  <td>
                    {entry.last_attempt}
                    {entry.succeeded === false && (
                      <span className="badge failure">failed</span>
                    )}
                  </td>
                  <td>{entry.failures}</td>
                </tr>
              ))}
              {(replication?.inbound ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    Nothing to replicate: this domain has one controller.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {adding && <AddControllerDialog onClose={() => setAdding(false)} />}
    </main>
  );
}

function AddControllerDialog({ onClose }: { onClose: () => void }) {
  const [hostname, setHostname] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [site, setSite] = useState("Default-First-Site-Name");
  const [command, setCommand] = useState<{ steps: string[]; notes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="Add a domain controller"
      submitLabel={command ? "Close" : "Show the commands"}
      error={error}
      wide
      onClose={onClose}
      onSubmit={async () => {
        if (command) {
          onClose();
          return;
        }
        try {
          setCommand(await api.controllers.joinCommand(hostname, readOnly, site));
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        }
      }}
    >
      {!command ? (
        <>
          <Field label="Machine to promote" hint="Its fully-qualified name">
            <input
              value={hostname}
              required
              placeholder="dc2.corp.example.internal"
              onChange={(e) => setHostname(e.target.value)}
            />
          </Field>
          <Field label="Site" hint="Which site the controller serves">
            <input value={site} onChange={(e) => setSite(e.target.value)} />
          </Field>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
            />
            Read-only, for a branch site
          </label>
          <p className="muted">
            A read-only controller keeps no account secrets, so a branch can authenticate without
            holding credentials that matter elsewhere. It is decided now and cannot be changed
            later — in ODM, in Samba, or in Windows.
          </p>
        </>
      ) : (
        <>
          <p className="muted">
            Run these on {hostname || "the machine becoming a controller"}, not here.
          </p>
          <pre className="wiki-code">{command.steps.join("\n")}</pre>
          <ul className="permission-list">
            {command.notes.map((note) => (
              <li key={note} style={{ borderRadius: "8px" }}>
                {note}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
