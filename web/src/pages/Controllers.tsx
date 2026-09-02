import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Server as ServerIcon } from "lucide-react";
import {
  ApiError,
  api,
  type AgentSchedule,
  type ControllerOverview,
  type DomainController,
  type Site,
} from "../api";
import { InfoPanel } from "../components/DocsLink";
import { Loading } from "../components/Loading";
import { Field, Modal } from "../components/Modal";
import { PickerField } from "../components/Picker";
import Select from "../components/Select"

function since(value: string | null): string {
  if (!value) return "never";
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 2) return "just now";
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

type Tab = "controllers" | "sites" | "agents";

/**
 * The controllers that hold the directory.
 *
 * Whether a controller is read-only is decided when it joins the domain and
 * cannot be changed afterwards — in Samba or in Windows. So this reports what
 * each one is and produces the command that adds another, rather than offering
 * a switch that could not do what it says.
 */
export function Controllers() {
  const [tab, setTab] = useState<Tab>("controllers");
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

      <InfoPanel page="domain-controllers">
        The controllers holding the directory, how they are replicating, and the sites that decide which one a client uses.
      </InfoPanel>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <nav className="tabs" aria-label="Domain controller views">
        {(["controllers", "sites", "agents"] as Tab[]).map((current) => (
          <button
            key={current}
            type="button"
            className={tab === current ? "tab active" : "tab"}
            aria-current={tab === current ? "true" : undefined}
            onClick={() => setTab(current)}
          >
            {current === "controllers"
              ? "Controllers"
              : current === "sites"
                ? "Sites and subnets"
                : "Agents"}
          </button>
        ))}
      </nav>

      {tab === "sites" && <Sites controllers={overview?.controllers ?? []} />}

      {tab === "agents" && <Agents />}

      {tab === "controllers" && (
        <>
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
                  <td>
                    {since(controller.last_seen)}
                    {controller.last_seen && (
                      <p className="stat-note">
                        {controller.last_seen_how}
                        {controller.last_policy_run
                          ? ` · policy ${since(controller.last_policy_run)}`
                          : " · policy not applied yet"}
                      </p>
                    )}
                  </td>
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
              {/* Each controller collects its own state with its inventory, so
                  say when it was collected: a controller that has stopped
                  reporting shows the last state it had, not the current one. */}
              {replication?.collected_at && (
                <p className="stat-note">Collected {since(replication.collected_at)}</p>
              )}
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Partition</th>
                    <th scope="col">From</th>
                    <th scope="col">On</th>
                    <th scope="col">Last attempt</th>
                    <th scope="col">Failures</th>
                  </tr>
                </thead>
                <tbody>
                  {(replication?.inbound ?? []).map((entry, index) => (
                    <tr key={index}>
                      <td className="mono">{entry.naming_context}</td>
                      <td className="mono">{entry.partner}</td>
                      <td className="mono">{entry.on ?? replication?.servers?.[0] ?? "—"}</td>
                      <td>
                        {entry.last_attempt}
                        {entry.succeeded === false && <span className="badge failure">failed</span>}
                      </td>
                      <td>{entry.failures}</td>
                    </tr>
                  ))}
                  {(replication?.inbound ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="empty">
                        {(replication?.servers ?? []).length === 0
                          ? "No controller has reported its replication state yet. Each one collects it with its inventory, so it appears at that controller's next check-in."
                          : "Nothing to replicate: this domain has one controller."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {adding && <AddControllerDialog onClose={() => setAdding(false)} />}
    </main>
  );
}

const POLL_INTERVALS: { minutes: AgentSchedule["poll_minutes"]; label: string }[] = [
  { minutes: 1, label: "Every minute" },
  { minutes: 5, label: "Every 5 minutes" },
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 30, label: "Every 30 minutes" },
];

/**
 * How often every machine in the domain asks for its policy.
 *
 * The interval reaches a machine in the policy document it already fetches,
 * so it takes effect at that machine's next poll. Pushing is separate: with it
 * on, a policy change is queued for the machines it reaches and the agent,
 * which already holds a request open for queued work, applies within seconds.
 */
function Agents() {
  const [schedule, setSchedule] = useState<AgentSchedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.controllers
      .agents()
      .then(setSchedule)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, []);

  async function save(next: AgentSchedule) {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      setSchedule(await api.controllers.setAgents(next));
      setNotice("Saved. Each machine picks this up at its next poll.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!schedule) {
    return error ? (
      <p className="alert" role="alert">
        {error}
      </p>
    ) : (
      <Loading label="Reading the agent schedule…" />
    );
  }

  return (
    <section className="role-configuration">
      <header>
        <h3>Policy refresh</h3>
        <p className="muted">
          Applies to every machine in the domain. A policy object that sets its own interval wins
          for the machines it reaches.
        </p>
      </header>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}

      <Field label="Polling interval" hint="How often an agent asks for its policy">
        <Select
          value={String(schedule.poll_minutes)}
          disabled={saving}
          aria-label="Polling interval"
          onChange={(e) =>
            void save({
              ...schedule,
              poll_minutes: Number(e.target.value) as AgentSchedule["poll_minutes"],
            })
          }
        >
          {POLL_INTERVALS.map((interval) => (
            <option key={interval.minutes} value={String(interval.minutes)}>
              {interval.label}
            </option>
          ))}
        </Select>
      </Field>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={schedule.push_enabled}
          disabled={saving}
          onChange={(e) => void save({ ...schedule, push_enabled: e.target.checked })}
        />
        Push a change to every machine as soon as it is made
      </label>
      <p className="muted">
        One request per machine per policy edit, on top of the polling above.
      </p>
    </section>
  );
}

function AddControllerDialog({ onClose }: { onClose: () => void }) {
  const [hostname, setHostname] = useState("");
  const [sites, setSites] = useState<string[]>([]);

  // The sites that exist, rather than a name to be spelled correctly.
  useEffect(() => {
    api.sites
      .list()
      .then((result) => setSites(result.sites.map((entry) => entry.name)))
      .catch(() => setSites([]));
  }, []);
  const [readOnly, setReadOnly] = useState(false);
  const [site, setSite] = useState("Default-First-Site-Name");
  const [command, setCommand] = useState<{
    steps: string[];
    notes: string[];
  } | null>(null);
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
          {/* A machine being promoted has almost always joined already, so
              it is in the directory and can be chosen rather than typed. */}
          <Field label="Machine to promote" hint="A domain member, or a name you are about to join">
            <PickerField
              kind="computer"
              as="host"
              ariaLabel="Machine to promote"
              value={hostname}
              required
              placeholder="dc2.corp.example.internal"
              onChange={setHostname}
            />
          </Field>
          <Field label="Site" hint="Which site the controller serves">
            <Select value={site} onChange={(e) => setSite(e.target.value)}>
              {(sites.length ? sites : ["Default-First-Site-Name"]).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
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
            holding credentials that matter elsewhere. It is decided now and cannot be changed later
            — in ODM, in Samba, or in Windows.
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

/**
 * Sites, subnets, and which controllers serve them.
 *
 * A subnet says which addresses are in a place; a machine reports its own and
 * is placed by the longest matching prefix, the way routing decides. That is
 * what lets a machine prefer a controller near it instead of whichever one
 * DNS happened to return.
 */
function Sites({ controllers }: { controllers: DomainController[] }) {
  const [sites, setSites] = useState<Site[]>([]);
  const [unplaced, setUnplaced] = useState(0);
  const [adding, setAdding] = useState(false);
  const [subnetFor, setSubnetFor] = useState<string | null>(null);
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.sites.list();
      setSites(result.sites);
      setUnplaced(result.unplaced);
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
      {notice && <p className="muted">{notice}</p>}

      <div className="actions-row">
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          <Plus size={15} aria-hidden="true" />
          New site
        </button>
      </div>

      {sites.map((site) => (
        <div key={site.name} className="site-card">
          <div className="page-header">
            <h3>{site.name}</h3>
            {site.description && <span className="muted">{site.description}</span>}
            <span className="spacer" />
            <span className="badge">{site.machines ?? 0} machines</span>
            <button type="button" className="ghost" onClick={() => setSubnetFor(site.name)}>
              Add a subnet
            </button>
            <button type="button" className="ghost" onClick={() => setAssignFor(site.name)}>
              Assign a controller
            </button>
            <button
              type="button"
              className="danger"
              onClick={async () => {
                await api.sites.remove(site.name).catch(() => undefined);
                void load();
              }}
            >
              Remove
            </button>
          </div>

          <table className="data compact">
            <tbody>
              <tr>
                <th scope="row" style={{ width: "160px" }}>
                  Subnets
                </th>
                <td>
                  {(site.subnets ?? []).length === 0 ? (
                    <span className="muted">
                      None, so nothing is placed here — a site with no subnet cannot be found.
                    </span>
                  ) : (
                    (site.subnets ?? []).map((subnet) => (
                      <span key={subnet.cidr} className="badge">
                        {subnet.cidr}
                        <button
                          type="button"
                          className="icon"
                          aria-label={`Remove ${subnet.cidr}`}
                          onClick={async () => {
                            await api.sites.removeSubnet(subnet.cidr).catch(() => undefined);
                            void load();
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Controllers</th>
                <td className="mono">
                  {(site.controllers ?? []).map((entry) => entry.hostname).join(", ") || (
                    <span className="muted">None assigned</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}

      {sites.length === 0 && (
        <p className="empty">
          No sites yet. One site with the networks you have is enough to start.
        </p>
      )}

      {unplaced > 0 && (
        <p className="muted">
          {unplaced} {unplaced === 1 ? "machine is" : "machines are"} in no site: their addresses
          match no subnet.
        </p>
      )}

      {adding && (
        <NameDialog
          title="New site"
          label="Name"
          placeholder="Head office"
          onClose={() => setAdding(false)}
          onSubmit={async (name, description) => {
            await api.sites.create(name, description);
            setAdding(false);
            void load();
          }}
        />
      )}

      {subnetFor && (
        <NameDialog
          title={`Add a subnet to ${subnetFor}`}
          label="Network"
          placeholder="10.10.0.0/24"
          hint="With a prefix. A more specific subnet wins over one containing it."
          onClose={() => setSubnetFor(null)}
          onSubmit={async (cidr, description) => {
            const result = await api.sites.addSubnet(cidr, subnetFor, description);
            setSubnetFor(null);
            setNotice(
              result.overlaps.length
                ? `${result.cidr} overlaps ${result.overlaps.join(", ")}. The more specific one decides.`
                : null,
            );
            void load();
          }}
        />
      )}

      {assignFor && (
        <Modal
          title={`Which controller serves ${assignFor}?`}
          submitLabel="Close"
          onClose={() => setAssignFor(null)}
          onSubmit={() => setAssignFor(null)}
        >
          <ul className="picker-results">
            {controllers.map((controller) => (
              <li key={controller.distinguished_name}>
                <button
                  type="button"
                  onClick={async () => {
                    await api.sites
                      .assign(controller.distinguished_name, assignFor, controller.fqdn)
                      .catch(() => undefined);
                    setAssignFor(null);
                    void load();
                  }}
                >
                  <ServerIcon size={15} aria-hidden="true" />
                  {controller.name}
                  <span className="secondary">{controller.fqdn}</span>
                </button>
              </li>
            ))}
            {controllers.length === 0 && <li className="empty">No controllers found.</li>}
          </ul>
        </Modal>
      )}
    </>
  );
}

function NameDialog({
  title,
  label,
  placeholder,
  hint,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  placeholder: string;
  hint?: string;
  onClose: () => void;
  onSubmit: (value: string, description: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={title}
      submitLabel="Add"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await onSubmit(value.trim(), description);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label={label} hint={hint}>
        <input
          value={value}
          required
          autoFocus
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <Field label="Description">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </Modal>
  );
}
