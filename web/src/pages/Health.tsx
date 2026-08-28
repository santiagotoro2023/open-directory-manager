import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Activity, Archive, RefreshCw } from "lucide-react";
import { ApiError, api, type BackupRecord, type HealthReport } from "../api";

type Tab = "health" | "replication" | "backups";

function bytes(value: number): string {
  if (value > 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GB`;
  if (value > 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${value} bytes`;
}

export function Health() {
  const [tab, setTab] = useState<Tab>("health");
  const [report, setReport] = useState<HealthReport | null>(null);
  const [replication, setReplication] = useState<Awaited<
    ReturnType<typeof api.operations.replication>
  > | null>(null);
  const [backups, setBackups] = useState<Awaited<
    ReturnType<typeof api.operations.backups>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (tab === "health") setReport(await api.operations.health());
      if (tab === "replication") setReplication(await api.operations.replication());
      if (tab === "backups") setBackups(await api.operations.backups());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="content">
      <div className="toolbar">
        <h1>Operations</h1>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <nav className="tabs" aria-label="Operations views">
        {(["health", "replication", "backups"] as Tab[]).map((current) => (
          <button
            key={current}
            type="button"
            className={tab === current ? "tab active" : "tab"}
            aria-current={tab === current ? "true" : undefined}
            onClick={() => setTab(current)}
          >
            {current === "health" ? "Health" : current === "replication" ? "Replication" : "Backups"}
          </button>
        ))}
      </nav>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}

      {tab === "health" && report && (
        <div className="health-grid">
          <Card title="Directory" icon={<Activity size={15} aria-hidden="true" />}>
            {report.directory.available ? (
              <>
                <p className="metric">{report.directory.controllers}</p>
                <p className="muted">
                  domain controller{report.directory.controllers === 1 ? "" : "s"}:{" "}
                  {(report.directory.names ?? []).join(", ")}
                </p>
              </>
            ) : (
              <p className="muted">{report.directory.detail ?? "unavailable"}</p>
            )}
          </Card>

          <Card title="Replication">
            {report.replication.available === false ? (
              <p className="muted">{report.replication.detail}</p>
            ) : (
              <>
                <span className={`badge ${report.replication.healthy ? "success" : "failure"}`}>
                  {report.replication.healthy ? "healthy" : "attention needed"}
                </span>
                <p className="muted">
                  {(report.replication.inbound ?? []).length} inbound partnerships
                </p>
              </>
            )}
          </Card>

          <Card title="Agents">
            <p className="metric">
              {report.agents.fresh} / {report.agents.checked_in}
            </p>
            <p className="muted">
              reporting within {report.agents.stale_after_minutes} minutes
              {report.agents.stale > 0 && (
                <>
                  {" · "}
                  <span className="badge failure">{report.agents.stale} stale</span>
                </>
              )}
            </p>
            {report.agents.failing_settings > 0 && (
              <p className="muted">{report.agents.failing_settings} settings failing to apply</p>
            )}
          </Card>

          <Card title="DHCP">
            {report.dhcp.configured === false ? (
              <p className="muted">role not installed</p>
            ) : (
              <ul className="plain">
                {Object.entries(report.dhcp.statistics ?? {})
                  .filter(([key]) => key.includes("assigned") || key.includes("total"))
                  .slice(0, 6)
                  .map(([key, value]) => (
                    <li key={key} className="mono">
                      {key}: {value}
                    </li>
                  ))}
              </ul>
            )}
          </Card>

          <Card title="Certificates">
            {report.certificates.initialised ? (
              <>
                <p className="muted">
                  authority valid until{" "}
                  {report.certificates.not_after &&
                    new Date(report.certificates.not_after).toLocaleDateString()}
                </p>
                {(report.certificates.expiring_soon ?? 0) > 0 && (
                  <span className="badge failure">
                    {report.certificates.expiring_soon} expiring within 30 days
                  </span>
                )}
              </>
            ) : (
              <p className="muted">no authority created</p>
            )}
          </Card>

          <Card title="Backups" icon={<Archive size={15} aria-hidden="true" />}>
            {report.backups.configured ? (
              <p className="muted">
                {report.backups.last
                  ? `last ${new Date(report.backups.last.started_at).toLocaleString()} · ${bytes(
                      report.backups.last.size_bytes,
                    )}`
                  : "no completed backup yet"}
                {" · every "}
                {report.backups.interval_hours}h
              </p>
            ) : (
              <p className="muted">not configured</p>
            )}
          </Card>
        </div>
      )}

      {tab === "replication" && replication && (
        <>
          <h2>Domain controllers</h2>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">DNS host name</th>
                <th scope="col">Operating system</th>
              </tr>
            </thead>
            <tbody>
              {replication.controllers.map((dc) => (
                <tr key={dc.name}>
                  <td>{dc.name}</td>
                  <td className="mono">{dc.dns_host_name}</td>
                  <td>{dc.operating_system}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Inbound replication on {replication.server}</h2>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Naming context</th>
                <th scope="col">Partner</th>
                <th scope="col">Last attempt</th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="sr-only">Replicate</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {replication.inbound.map((entry, index) => (
                <tr key={`${entry.naming_context}-${index}`}>
                  <td className="mono">{entry.naming_context}</td>
                  <td>{entry.partner}</td>
                  <td>{entry.last_attempt}</td>
                  <td>
                    <span className={`badge ${entry.succeeded ? "success" : "failure"}`}>
                      {entry.succeeded ? "ok" : `${entry.failures} failures`}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost"
                      onClick={async () => {
                        setNotice(null);
                        setError(null);
                        try {
                          await api.operations.replicate(
                            replication.server,
                            entry.partner.split("\\").pop() ?? entry.partner,
                            entry.naming_context,
                          );
                          setNotice(`Replicated ${entry.naming_context}.`);
                          await load();
                        } catch (err) {
                          setError(err instanceof ApiError ? err.message : String(err));
                        }
                      }}
                    >
                      Replicate now
                    </button>
                  </td>
                </tr>
              ))}
              {replication.inbound.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No inbound partnerships. A single-controller domain has nothing to replicate.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {tab === "backups" && backups && (
        <>
          {!backups.configured ? (
            <p className="muted">
              No backup directory configured. Set ODM_BACKUP_DIR in the secrets file to enable
              scheduled and on-demand backups.
            </p>
          ) : (
            <>
              <p className="muted">
                {backups.directory} · every {backups.interval_hours} hours · keeping the newest{" "}
                {backups.keep}
              </p>
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  setNotice(null);
                  try {
                    await api.operations.takeBackup();
                    setNotice("Backup started. It appears below when it finishes.");
                  } catch (err) {
                    setError(err instanceof ApiError ? err.message : String(err));
                  }
                }}
              >
                <Archive size={15} aria-hidden="true" />
                Back up now
              </button>
              <BackupTable history={backups.history} />
            </>
          )}
        </>
      )}
    </main>
  );
}

function BackupTable({ history }: { history: BackupRecord[] }) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th scope="col">Started</th>
          <th scope="col">State</th>
          <th scope="col">Size</th>
          <th scope="col">Archive</th>
          <th scope="col">Taken by</th>
        </tr>
      </thead>
      <tbody>
        {history.map((entry) => (
          <tr key={entry.id}>
            <td>{new Date(entry.started_at).toLocaleString()}</td>
            <td>
              <span
                className={`badge ${
                  entry.state === "complete" ? "success" : entry.state === "failed" ? "failure" : ""
                }`}
              >
                {entry.state}
              </span>
              {entry.detail && <p className="muted">{entry.detail}</p>}
            </td>
            <td>{entry.size_bytes ? bytes(entry.size_bytes) : ""}</td>
            <td className="mono">{entry.path.startsWith("pending:") ? "" : entry.path}</td>
            <td>{entry.taken_by}</td>
          </tr>
        ))}
        {history.length === 0 && (
          <tr>
            <td colSpan={5} className="muted">
              No backups taken yet.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="health-card">
      <h3>
        {icon}
        {title}
      </h3>
      {children}
    </article>
  );
}
