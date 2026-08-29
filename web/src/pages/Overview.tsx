import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Activity, Archive, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  ApiError,
  api,
  type BackupRecord,
  type HealthReport,
  type PasswordPolicy,
  type SessionInfo,
} from "../api";
import { Field, Modal } from "../components/Modal";
import { ContainerPicker, PickerDialog } from "../components/Picker";

type Tab = "health" | "replication" | "backups" | "passwords";

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
      <div className="page-header">
        <h1>Overview</h1>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <nav className="tabs" aria-label="Operations views">
        {(["health", "replication", "backups", "passwords"] as Tab[]).map((current) => (
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
                  : "Password policy"}
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

          <Card title="Signed in as">
            <p>{session.display_name}</p>
            <p className="mono muted">{session.distinguished_name}</p>
            <p className="muted">
              session ends {new Date(session.expires_at).toLocaleString()}
            </p>
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

      {tab === "passwords" && <PasswordPolicy />}

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


/**
 * What a password in this domain has to be.
 *
 * The rule lives in the directory, not here: Samba enforces it on every
 * password change however it is made, and a second copy in ODM would look
 * authoritative without being it.
 */
function PasswordPolicy() {
  const [policy, setPolicy] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPolicy((await api.password.policy()).policy);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fields: { key: string; label: string; hint?: string }[] = [
    { key: "min_pwd_length", label: "Minimum length" },
    { key: "history_length", label: "Passwords remembered", hint: "Cannot be reused" },
    { key: "min_pwd_age", label: "Minimum age (days)", hint: "Before it can be changed again" },
    { key: "max_pwd_age", label: "Maximum age (days)", hint: "0 means it never expires" },
    { key: "account_lockout_threshold", label: "Lock out after", hint: "Failed attempts; 0 is never" },
    { key: "account_lockout_duration", label: "Locked out for (minutes)" },
    { key: "reset_account_lockout_after", label: "Reset the count after (minutes)" },
  ];

  return (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {saved && <p className="muted">Saved. It applies to the next password set, not existing ones.</p>}

      <h3 className="section-title">As the directory holds it</h3>
      <table className="data compact">
        <tbody>
          {Object.entries(policy).map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td className="mono">{value}</td>
            </tr>
          ))}
          {Object.keys(policy).length === 0 && (
            <tr>
              <td className="empty">
                Not readable from here. Password policy needs the control plane on a domain
                controller.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">Change it</h3>
      <div className="field-grid">
        <label className="field">
          <span>Complexity</span>
          <select
            value={draft.complexity ?? ""}
            onChange={(e) => setDraft({ ...draft, complexity: e.target.value })}
          >
            <option value="">Leave as it is</option>
            <option value="on">Required</option>
            <option value="off">Not required</option>
          </select>
        </label>
        {fields.map((field) => (
          <label key={field.key} className="field">
            <span>{field.label}</span>
            <input
              type="number"
              value={draft[field.key] ?? ""}
              placeholder="unchanged"
              onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
            />
            {field.hint && <small>{field.hint}</small>}
          </label>
        ))}
      </div>

      <div className="actions-row">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setSaved(false);
            try {
              const body: Record<string, string | number> = {};
              for (const [key, value] of Object.entries(draft)) {
                if (value === "") continue;
                body[key] = key === "complexity" ? value : Number(value);
              }
              if (Object.keys(body).length === 0) return;
              setPolicy((await api.password.updatePolicy(body)).policy);
              setDraft({});
              setSaved(true);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Apply
        </button>
      </div>

      <h3 className="section-title">Policies for particular people</h3>
      <p className="muted">
        The settings above are the domain&rsquo;s. A policy here overrides them for the accounts
        it reaches — tighter for administrators, say. Active Directory applies these to users and
        groups, never to a container, so an organizational unit is resolved to the users beneath
        it and re-resolved as people are added.
      </p>
      <FineGrainedPolicies />

      <p className="muted">
        Whether people may change their own password from the console is a policy setting:{" "}
        <strong>Group Policy</strong> → <strong>User</strong> →{" "}
        <strong>Self-service password</strong>.
      </p>
    </>
  );
}

function FineGrainedPolicies() {
  const [policies, setPolicies] = useState<PasswordPolicy[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPolicies((await api.password.policies()).policies);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <table className="data">
        <thead>
          <tr>
            <th scope="col" style={{ width: "110px" }}>
              Precedence
            </th>
            <th scope="col">Policy</th>
            <th scope="col">Requires</th>
            <th scope="col">Reaches</th>
            <th scope="col">State</th>
            <th scope="col">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {policies.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.precedence}</td>
              <td>
                <strong>{entry.name}</strong>
                {entry.description && <p className="muted">{entry.description}</p>}
              </td>
              <td>
                {entry.min_length} characters
                {entry.complexity && ", complex"}
                {entry.max_age_days > 0 && `, expires after ${entry.max_age_days} days`}
              </td>
              <td>
                {entry.applied_to.length} {entry.applied_to.length === 1 ? "account" : "accounts"}
                {entry.container_dns.length > 0 && (
                  <span className="badge">{entry.container_dns.length} containers</span>
                )}
              </td>
              <td>
                <span className={`badge ${entry.state === "active" ? "success" : "failure"}`}>
                  {entry.state}
                </span>
                {entry.last_error && <p className="muted">{entry.last_error}</p>}
              </td>
              <td>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Remove ${entry.name}`}
                  onClick={async () => {
                    await api.password.removePolicy(entry.id).catch(() => undefined);
                    void load();
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
          {policies.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                None. Everybody gets the domain policy above.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="actions-row">
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          <Plus size={15} aria-hidden="true" />
          New policy
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await api.password.syncPolicies().catch(() => undefined);
            setBusy(false);
            void load();
          }}
        >
          <RefreshCw size={15} aria-hidden="true" />
          Re-apply now
        </button>
      </div>

      {adding && (
        <PasswordPolicyDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </>
  );
}

function PasswordPolicyDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [precedence, setPrecedence] = useState(50);
  const [complexity, setComplexity] = useState(true);
  const [minLength, setMinLength] = useState(14);
  const [history, setHistory] = useState(10);
  const [maxAge, setMaxAge] = useState(0);
  const [lockout, setLockout] = useState(5);
  const [groups, setGroups] = useState<{ dn: string; name: string }[]>([]);
  const [containers, setContainers] = useState<string[]>([]);
  const [picking, setPicking] = useState<"group" | "container" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="New password policy"
      submitLabel="Create"
      busy={busy}
      error={error}
      wide
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.password.createPolicy({
            name,
            description,
            precedence,
            complexity,
            min_length: minLength,
            history,
            max_age_days: maxAge,
            lockout_threshold: lockout,
            group_dns: groups.map((entry) => entry.dn),
            container_dns: containers,
          });
          onSaved();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name">
        <input
          value={name}
          required
          placeholder="administrators"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Description">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <div className="field-grid">
        <label className="field">
          <span>Minimum length</span>
          <input
            type="number"
            value={minLength}
            onChange={(e) => setMinLength(Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Passwords remembered</span>
          <input
            type="number"
            value={history}
            onChange={(e) => setHistory(Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Expires after (days)</span>
          <input type="number" value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))} />
          <small>0 means never</small>
        </label>
        <label className="field">
          <span>Lock out after</span>
          <input type="number" value={lockout} onChange={(e) => setLockout(Number(e.target.value))} />
          <small>Failed attempts; 0 is never</small>
        </label>
        <label className="field">
          <span>Precedence</span>
          <input
            type="number"
            value={precedence}
            onChange={(e) => setPrecedence(Number(e.target.value))}
          />
          <small>Lower wins where two policies reach the same account</small>
        </label>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={complexity}
          onChange={(e) => setComplexity(e.target.checked)}
        />
        Require mixed character classes
      </label>

      <h3 className="section-title">Who it reaches</h3>
      <div className="actions-row">
        <button type="button" className="ghost" onClick={() => setPicking("group")}>
          Add a group
        </button>
        <button type="button" className="ghost" onClick={() => setPicking("container")}>
          Add an organizational unit
        </button>
      </div>
      <ul className="permission-list">
        {groups.map((entry) => (
          <li key={entry.dn}>{entry.name}</li>
        ))}
        {containers.map((dn) => (
          <li key={dn} className="mono">
            {dn}
          </li>
        ))}
        {groups.length === 0 && containers.length === 0 && (
          <li className="muted">Nobody yet — a policy has to reach somebody.</li>
        )}
      </ul>

      {picking === "group" && (
        <PickerDialog
          kind="group"
          onClose={() => setPicking(null)}
          onPick={(object) => {
            setPicking(null);
            setGroups((current) => [
              ...current,
              {
                dn: object.distinguishedName,
                name: String(object.sAMAccountName ?? object.cn ?? ""),
              },
            ]);
          }}
        />
      )}
      {picking === "container" && (
        <ContainerPicker
          title="Which organizational unit?"
          submitLabel="Add"
          onlyOrganizationalUnits
          onClose={() => setPicking(null)}
          onPick={(dn) => {
            setPicking(null);
            setContainers((current) => (current.includes(dn) ? current : [...current, dn]));
          }}
        />
      )}
    </Modal>
  );
}
