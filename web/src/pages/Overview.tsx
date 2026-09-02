import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Archive, RefreshCw } from "lucide-react";
import {
  ApiError,
  api,
  type BackupRecord,
  type HealthReport,
  type SessionInfo,
} from "../api";

type Tab = "health" | "replication" | "backups";

/** What a row in the services table is saying, at a glance. */
type State = "ok" | "attention" | "off";

const STATE_LABEL: Record<State, string> = {
  ok: "Healthy",
  attention: "Needs attention",
  off: "Not installed",
};

function ago(value: string): string {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 2) return "just now";
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * The dashboard: four numbers worth knowing, then one row per subsystem.
 *
 * The previous version was a grid of cards each holding a paragraph, so every
 * card was a different height, a long error ran out of its box, and a domain
 * with nothing wrong with it filled a third of the window with white space.
 * Counts belong in tiles that are all the same size; prose belongs in a table
 * cell, where a long sentence wraps instead of overflowing.
 */
function Health({ report, session }: { report: HealthReport; session: SessionInfo }) {
  const certificates = report.certificates;
  const services: {
    name: string;
    state: State;
    detail: ReactNode;
  }[] = [
    {
      name: "Directory",
      state: report.directory.available === false ? "attention" : "ok",
      detail:
        report.directory.available === false
          ? (report.directory.detail ?? "unavailable")
          : (report.directory.names ?? []).join(", ") || "—",
    },
    {
      name: "Replication",
      state:
        report.replication.available === false
          ? "attention"
          : report.replication.healthy === false
            ? "attention"
            : "ok",
      detail:
        report.replication.available === false
          ? report.replication.detail
          : (report.replication.inbound ?? []).length === 0
            ? "One controller. Nothing to replicate."
            : `${(report.replication.inbound ?? []).length} inbound partnerships`,
    },
    {
      name: "DHCP",
      state: report.dhcp.configured === false ? "off" : "ok",
      detail:
        report.dhcp.configured === false
          ? "Add the role under Server Roles to hand out addresses."
          : Object.entries(report.dhcp.statistics ?? {})
              .filter(([key]) => key.includes("assigned") || key.includes("total"))
              .slice(0, 3)
              .map(([key, value]) => `${key} ${value}`)
              .join(" · ") || "running",
    },
    {
      name: "Certificate authority",
      state: certificates.initialised
        ? (certificates.expiring_soon ?? 0) > 0
          ? "attention"
          : "ok"
        : "off",
      detail: certificates.initialised
        ? `Valid until ${certificates.not_after ? new Date(certificates.not_after).toLocaleDateString() : "—"}` +
          ((certificates.expiring_soon ?? 0) > 0
            ? ` · ${certificates.expiring_soon} expiring within 30 days`
            : "")
        : "No authority created.",
    },
    {
      name: "Backups",
      state: !report.backups.configured ? "off" : report.backups.last ? "ok" : "attention",
      detail: !report.backups.configured
        ? "Set ODM_BACKUP_DIR in the secrets file to enable them."
        : report.backups.last
          ? `Last ${ago(report.backups.last.started_at)} · ${bytes(
              report.backups.last.size_bytes,
            )} · every ${report.backups.interval_hours}h`
          : `No backup has completed yet · every ${report.backups.interval_hours}h`,
    },
  ];

  return (
    <>
      <div className="stat-row">
        <Stat
          value={
            report.directory.available === false ? "—" : String(report.directory.controllers ?? 0)
          }
          label="Domain controllers"
        />
        <Stat
          value={`${report.agents.fresh}/${report.agents.checked_in}`}
          label="Agents reporting"
          note={`within ${report.agents.stale_after_minutes} min`}
          attention={report.agents.stale > 0}
        />
        <Stat
          value={String(report.agents.failing_settings)}
          label="Settings failing"
          attention={report.agents.failing_settings > 0}
        />
        <Stat
          value={certificates.initialised ? String(certificates.expiring_soon ?? 0) : "—"}
          label="Certificates expiring"
          note="within 30 days"
          attention={(certificates.expiring_soon ?? 0) > 0}
        />
      </div>

      {(report.agents.failing ?? []).length > 0 && (
        <>
          <h2 className="section-title">Settings failing</h2>
          <table className="data">
            <thead>
              <tr>
                <th scope="col" style={{ width: "260px" }}>
                  Machine
                </th>
                <th scope="col" style={{ width: "220px" }}>
                  Setting
                </th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {(report.agents.failing ?? []).map((entry, index) => (
                <tr key={`${entry.hostname}-${entry.setting}-${index}`}>
                  <td className="mono">{entry.hostname}</td>
                  <td className="mono">{entry.setting}</td>
                  <td>{entry.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <table className="data">
        <thead>
          <tr>
            <th scope="col" style={{ width: "200px" }}>
              Service
            </th>
            <th scope="col" style={{ width: "160px" }}>
              State
            </th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {services.map((service) => (
            <tr key={service.name}>
              <th scope="row">{service.name}</th>
              <td>
                <span className={`state state-${service.state}`}>
                  <span className="dot" aria-hidden="true" />
                  {STATE_LABEL[service.state]}
                </span>
              </td>
              <td>{service.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted signed-in">
        Signed in as {session.display_name} · session ends{" "}
        {new Date(session.expires_at).toLocaleString()}
      </p>
    </>
  );
}

function Stat({
  value,
  label,
  note,
  attention,
}: {
  value: string;
  label: string;
  note?: string;
  attention?: boolean;
}) {
  return (
    <div className={attention ? "stat attention" : "stat"}>
      <p className="stat-value">{value}</p>
      <p className="stat-label">{label}</p>
      {note && <p className="stat-note">{note}</p>}
    </div>
  );
}

function bytes(value: number): string {
  if (value > 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GB`;
  if (value > 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${value} bytes`;
}

export function Overview({ session }: { session: SessionInfo }) {
  const [tab, setTab] = useState<Tab>("health");
  const [report, setReport] = useState<HealthReport | null>(null);
  const [replication, setReplication] = useState<Awaited<
    ReturnType<typeof api.operations.replication>
  > | null>(null);
  const [backups, setBackups] = useState<Awaited<ReturnType<typeof api.operations.backups>> | null>(
    null,
  );
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

  // A backup takes minutes, and the row said "No backups taken yet" until
  // something else caused a reload. Follow it while it runs.
  useEffect(() => {
    if (tab !== "backups") return;
    if (!backups?.history.some((entry) => entry.state === "running")) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [tab, backups, load]);

  return (
    <main className="content">
      <div className="page-header">
        <h1>Overview</h1>
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
            {current === "health"
              ? "Health"
              : current === "replication"
                ? "Replication"
                : "Backups"}
          </button>
        ))}
      </nav>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}

      {tab === "health" && report && <Health report={report} session={session} />}

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

          <h2>
            {replication.controllers.length < 2
              ? "Inbound replication"
              : `Inbound replication on ${replication.server}`}
          </h2>
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
                  <td colSpan={5} className="empty">
                    {replication.controllers.length < 2
                      ? "One controller. Nothing to replicate — add a second under Domain Controllers."
                      : "No inbound partnerships."}
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
              <div className="actions-row">
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
              </div>
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
              {/* samba-tool reports no percentage, so this says how long it
                  has been going rather than inventing one. */}
              {entry.state === "running" && (
                <p className="stat-note">
                  Running for {elapsed(entry.started_at)}. A domain backup copies the whole
                  directory and SYSVOL.
                </p>
              )}
              {entry.detail && <pre className="failure-output">{entry.detail}</pre>}
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

/** How long something has been going, in words. */
function elapsed(since: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}
