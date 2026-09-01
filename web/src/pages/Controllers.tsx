import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Server as ServerIcon } from "lucide-react";
import { ApiError, api, type ControllerOverview, type DomainController, type Site } from "../api";
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

type Tab = "controllers" | "sites";

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

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <nav className="tabs" aria-label="Domain controller views">
        {(["controllers", "sites"] as Tab[]).map((current) => (
          <button
            key={current}
            type="button"
            className={tab === current ? "tab active" : "tab"}
            aria-current={tab === current ? "true" : undefined}
            onClick={() => setTab(current)}
          >
            {current === "controllers" ? "Controllers" : "Sites and subnets"}
          </button>
        ))}
      </nav>

      {tab === "sites" && <Sites controllers={overview?.controllers ?? []} />}

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
                        {entry.succeeded === false && <span className="badge failure">failed</span>}
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
        </>
      )}

      {adding && <AddControllerDialog onClose={() => setAdding(false)} />}
    </main>
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
