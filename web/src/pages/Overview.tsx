import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Archive, Download, RefreshCw, Upload } from "lucide-react";
import {
  ApiError,
  api,
  type BackupRecord,
  type BaselineCheck,
  type DomainImportSummary,
  type HealthReport,
  type SessionInfo,
} from "../api";
import { FileInput } from "../components/FileInput";

type Tab = "health" | "replication" | "backups" | "baseline" | "configuration";

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
        {(["health", "replication", "backups", "baseline", "configuration"] as Tab[]).map(
          (current) => (
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
                : current === "backups"
                  ? "Backups"
                  : current === "baseline"
                    ? "Security baseline"
                    : "Configuration"}
            </button>
          ),
        )}
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
      {tab === "baseline" && <BaselineTab />}

      {tab === "configuration" && <ConfigurationTab />}
    </main>
  );
}

/**
 * The whole domain's configuration, out as one file and back in from one.
 *
 * Not a backup, and beside one rather than instead of it: a backup is this
 * domain's own database, restorable only onto a controller of the same
 * domain. This is every setting written out in a form somebody can read,
 * which is what makes it useful for building a second domain like this one,
 * for keeping a record of what was configured, and for handing to whoever is
 * being asked why something behaves the way it does.
 */
function ConfigurationTab() {
  const [summary, setSummary] = useState<DomainImportSummary | null>(null);
  const [document, setDocument] = useState<string>("");
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof api.operations.importDomain>
  > | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function read(content: string) {
    setError(null);
    setResult(null);
    setConfirm("");
    setDocument(content);
    setBusy(true);
    try {
      setSummary((await api.operations.importDomain(content, false)).summary);
    } catch (err) {
      setSummary(null);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3 className="section-title">Export</h3>
      <p className="muted">
        Every object in the directory, every DNS zone beside it, and every setting built on top
        &mdash; policy objects, shares, printers, scopes, collections, roles and delegations
        &mdash; in one file. Credentials are not in it: private keys, shared secrets, rotated
        local-administrator passwords, join tokens and password hashes are left out on purpose,
        and the file names which it withheld.
      </p>
      <div className="actions-row">
        <button
          type="button"
          className="primary"
          onClick={() => {
            // A download rather than a fetch: the browser saves the file, and
            // the API records who asked for it.
            window.location.href = api.operations.exportUrl();
          }}
        >
          <Download size={15} aria-hidden="true" />
          Download the configuration
        </button>
      </div>

      <h3 className="section-title">Import</h3>
      <p className="muted">
        Makes this domain the one in the file. ODM&rsquo;s own store is replaced wholesale, and
        every object in the file is created here. Accounts come back disabled and without a
        password, because the export never carried one.
      </p>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <FileInput
        accept="application/json,.json"
        placeholder="No export chosen"
        onChoose={(file) => void file.text().then(read)}
      />

      {busy && <p className="muted">Reading&hellip;</p>}

      {summary && !result && (
        <>
          <dl className="definition">
            <dt>Taken</dt>
            <dd>{summary.taken_at ? new Date(summary.taken_at).toLocaleString() : "unknown"}</dd>
            <dt>From</dt>
            <dd className="mono">
              {summary.from_domain ?? "unknown"} · ODM {summary.from_version ?? "unknown"}
            </dd>
            <dt>Directory</dt>
            <dd>
              {summary.organizational_units} organizational units, {summary.groups} groups,{" "}
              {summary.users} users, {summary.computers} computers
            </dd>
            <dt>DNS</dt>
            <dd>
              {summary.dns_zones} zones, {summary.dns_records} records
            </dd>
            <dt>Settings</dt>
            <dd>
              {Object.entries(summary.tables)
                .map(([name, count]) => `${name} (${count})`)
                .join(", ") || "none"}
            </dd>
            {summary.withheld.length > 0 && (
              <>
                <dt>Withheld</dt>
                <dd>{summary.withheld.join(", ")}</dd>
              </>
            )}
          </dl>

          <p className="alert" role="alert">
            This replaces the configuration of the domain you are signed in to. Type{" "}
            <strong>import</strong> to confirm.
          </p>
          <div className="picker-field">
            <input
              aria-label="Type import to confirm"
              value={confirm}
              placeholder="import"
              onChange={(event) => setConfirm(event.target.value)}
            />
            <button
              type="button"
              className="danger"
              disabled={confirm !== "import" || busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setResult(await api.operations.importDomain(document, true));
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Upload size={15} aria-hidden="true" />
              Import
            </button>
          </div>
        </>
      )}

      {result?.result && (
        <>
          <p>
            Imported{" "}
            {Object.entries(result.result.directory)
              .map(([name, count]) => `${count} ${name.replace(/_/g, " ")}`)
              .join(", ")}
            , {result.result.dns.zones} DNS zones and {result.result.dns.records} records.
          </p>
          {result.result.problems.length > 0 && (
            <>
              <h4 className="section-title">What did not come back</h4>
              <pre className="command-output">{result.result.problems.join("\n")}</pre>
            </>
          )}
        </>
      )}
    </>
  );
}

const SEVERITY_LABEL: Record<BaselineCheck["severity"], string> = {
  critical: "Needs attention now",
  warning: "Worth looking at",
  advisory: "Worth knowing",
  ok: "Fine",
  unknown: "Could not be checked",
};

const SEVERITY_BADGE: Record<BaselineCheck["severity"], string> = {
  critical: "failure",
  warning: "failure",
  advisory: "",
  ok: "success",
  unknown: "",
};

/**
 * The domain measured against a security checklist.
 *
 * Every check reads something ODM already holds and answers one question an
 * auditor asks. Nothing here changes anything, and each finding says where in
 * the console it is fixed: a report nobody can act on is a complaint.
 */
function BaselineTab() {
  const [report, setReport] = useState<Awaited<
    ReturnType<typeof api.operations.baseline>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.operations.baseline());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }
  if (loading || !report) return <p className="muted">Checking…</p>;

  return (
    <>
      <p className="muted">
        Taken {new Date(report.taken_at).toLocaleString()} ·{" "}
        {report.score.critical ?? 0} needing attention, {report.score.warning ?? 0} worth looking
        at, {report.score.ok ?? 0} fine. Nothing here changes anything.
      </p>

      <table className="data">
        <thead>
          <tr>
            <th scope="col" style={{ width: "260px" }}>
              Check
            </th>
            <th scope="col" style={{ width: "190px" }}>
              Verdict
            </th>
            <th scope="col">Finding</th>
            <th scope="col" style={{ width: "150px" }}>
              Where
            </th>
          </tr>
        </thead>
        <tbody>
          {report.checks.map((check) => (
            <tr
              key={check.key}
              onClick={() =>
                setOpen((was) => {
                  const next = new Set(was);
                  if (next.has(check.key)) next.delete(check.key);
                  else next.add(check.key);
                  return next;
                })
              }
              style={check.detail.length > 0 ? { cursor: "pointer" } : undefined}
            >
              <td>{check.title}</td>
              <td>
                <span className={`badge ${SEVERITY_BADGE[check.severity]}`}>
                  {SEVERITY_LABEL[check.severity]}
                </span>
              </td>
              <td>
                {check.finding}
                {check.detail.length > 0 && open.has(check.key) && (
                  <pre className="command-output">{check.detail.join("\n")}</pre>
                )}
                {check.detail.length > 0 && !open.has(check.key) && (
                  <p className="stat-note">Click to see which.</p>
                )}
              </td>
              <td className="muted">{check.where}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
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
