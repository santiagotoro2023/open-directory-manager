import { Fragment, useCallback, useEffect, useState } from "react";
import { ApiError, api, type AuditEntry } from "../api";

const OUTCOMES = ["", "success", "denied", "failure"];

export function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [filters, setFilters] = useState({ actor: "", action: "", object_dn: "", outcome: "" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.audit.list({ ...filters, limit: 200 });
      setEntries(result.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [filters]);

  useEffect(() => {
    api.audit.actions().then(setActions).catch(() => setActions([]));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div className="content">
      <h1>Audit Log</h1>

      <div className="toolbar">
        <input
          aria-label="Filter by actor"
          placeholder="Actor"
          value={filters.actor}
          onChange={(e) => setFilters({ ...filters, actor: e.target.value })}
        />
        <input
          aria-label="Filter by distinguished name"
          placeholder="Distinguished name"
          value={filters.object_dn}
          onChange={(e) => setFilters({ ...filters, object_dn: e.target.value })}
        />
        <select
          aria-label="Filter by action"
          value={filters.action}
          onChange={(e) => setFilters({ ...filters, action: e.target.value })}
        >
          <option value="">All actions</option>
          {actions.map((action) => (
            <option key={action} value={action}>
              {action}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by outcome"
          value={filters.outcome}
          onChange={(e) => setFilters({ ...filters, outcome: e.target.value })}
        >
          {OUTCOMES.map((outcome) => (
            <option key={outcome} value={outcome}>
              {outcome === "" ? "All outcomes" : outcome}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <table className="data">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Actor</th>
            <th scope="col">Action</th>
            <th scope="col">Object</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <Fragment key={entry.id}>
              <tr onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}>
                <td>{new Date(entry.occurred_at).toLocaleString()}</td>
                <td>{entry.actor}</td>
                <td className="mono">{entry.action}</td>
                <td className="mono">{entry.object_dn ?? ""}</td>
                <td>
                  <span className={`badge ${entry.outcome}`}>{entry.outcome}</span>
                </td>
              </tr>
              {expanded === entry.id && (
                <tr>
                  <td colSpan={5}>
                    {entry.detail && <p>{entry.detail}</p>}
                    <div className="diff">
                      <div>
                        <h3>Before</h3>
                        <pre>{JSON.stringify(entry.before_state, null, 2)}</pre>
                      </div>
                      <div>
                        <h3>After</h3>
                        <pre>{JSON.stringify(entry.after_state, null, 2)}</pre>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No matching entries.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
