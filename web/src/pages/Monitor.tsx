import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ApiError,
  api,
  type DashboardData,
  type DashboardWidget,
  type MaintenanceWindow,
  type MonitorAlert,
  type MonitorChannel,
  type MonitorDashboard,
  type MonitorGroup,
  type MonitorHost,
  type MonitorProbe,
  type MonitorRule,
} from "../api";
import { InfoPanel } from "../components/DocsLink";
import { Field, Modal } from "../components/Modal";
import { QrCode } from "../components/QrCode";
import Select from "../components/Select";
import { Loading, LoadingRow } from "../components/Loading";
import { DashboardGrid, HostsWidget, METRIC_LABELS, formatValue, metricMeta } from "../components/monitor/Dashboard";
import { WATCH, useLive } from "../live";

type Tab = "dashboards" | "hosts" | "alerts" | "rules" | "channels" | "maintenance" | "probes";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboards", label: "Dashboards" },
  { id: "hosts", label: "Hosts & groups" },
  { id: "alerts", label: "Alerts" },
  { id: "rules", label: "Rules" },
  { id: "channels", label: "Channels" },
  { id: "maintenance", label: "Maintenance" },
  { id: "probes", label: "Probes" },
];

const METRIC_OPTIONS = Object.entries(METRIC_LABELS).map(([metric, meta]) => ({
  value: metric,
  label: metric.endsWith(":") ? `${meta.label} (each)` : meta.label,
}));

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

function minutes(seconds: number): string {
  if (seconds === 0) return "at once";
  return seconds % 3600 === 0 ? `${seconds / 3600} h` : `${Math.round(seconds / 60)} min`;
}

/**
 * Monitoring: what the machines say about themselves, and what to do about
 * it. One page, seven tabs, because the parts belong together — a rule
 * names a group and a channel, a dashboard names a channel, a window names
 * a group — and a section apiece in the sidebar would be seven places to
 * look for one thing.
 */
export function Monitor() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "dashboards";
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof api.monitor.overview>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(() => {
    api.monitor
      .overview()
      .then((result) => {
        setOverview(result);
        setError(null);
      })
      .catch((err) => setError(describeError(err)));
  }, []);
  useEffect(loadOverview, [loadOverview]);
  useLive(WATCH.roles, loadOverview);

  return (
    <div className="content">
      <h1>Monitoring</h1>
      <InfoPanel page="monitoring">
        Every machine reports its processor, memory, filesystems, network and temperature once a
        minute; the machine carrying the role probes what has no agent. Rules turn the numbers into
        alerts, channels carry them to a phone, and dashboards show them.
      </InfoPanel>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {overview && !overview.active && (
        <p className="alert">
          The monitoring role is not installed anywhere yet. Install it from Server Roles; every
          machine starts reporting on its next policy refresh.
        </p>
      )}
      {overview && overview.active && (
        <div className="stat-row">
          <div className="stat">
            <p className="stat-value">{overview.hosts}</p>
            <p className="stat-label">Machines reporting</p>
          </div>
          <div className={overview.down ? "stat attention" : "stat"}>
            <p className="stat-value">{overview.down}</p>
            <p className="stat-label">Not heard from</p>
          </div>
          <div className={overview.firing.critical ? "stat attention" : "stat"}>
            <p className="stat-value">{overview.firing.critical ?? 0}</p>
            <p className="stat-label">Critical alerts</p>
          </div>
          <div className="stat">
            <p className="stat-value">{overview.firing.warning ?? 0}</p>
            <p className="stat-label">Warnings</p>
          </div>
        </div>
      )}

      <nav className="tabs" aria-label="Monitoring sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={tab === entry.id ? "tab active" : "tab"}
            onClick={() => setParams({ tab: entry.id })}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === "dashboards" && <DashboardsTab />}
      {tab === "hosts" && <HostsTab />}
      {tab === "alerts" && <AlertsTab />}
      {tab === "rules" && <RulesTab />}
      {tab === "channels" && <ChannelsTab />}
      {tab === "maintenance" && <MaintenanceTab />}
      {tab === "probes" && <ProbesTab />}
    </div>
  );
}

// ------------------------------------------------------------- dashboards --

function DashboardsTab() {
  const [dashboards, setDashboards] = useState<MonitorDashboard[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData>({});
  const [editing, setEditing] = useState<MonitorDashboard | null>(null);
  const [channels, setChannels] = useState<MonitorChannel[]>([]);
  const [groups, setGroups] = useState<MonitorGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const result = await api.monitor.dashboards();
      setDashboards(result.dashboards);
      setSelected((was) => was ?? result.dashboards.find((d) => d.is_default)?.id ?? result.dashboards[0]?.id ?? null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  const loadData = useCallback(async () => {
    if (!selected) return;
    try {
      const result = await api.monitor.dashboardData(selected);
      setData(result.data);
      setDashboards((was) => was.map((d) => (d.id === result.dashboard.id ? result.dashboard : d)));
    } catch (err) {
      setError(describeError(err));
    }
  }, [selected]);

  useEffect(() => {
    void loadList();
    api.monitor.channels().then((r) => setChannels(r.channels)).catch(() => undefined);
    api.monitor.groups().then((r) => setGroups(r.groups)).catch(() => undefined);
  }, [loadList]);

  useEffect(() => {
    void loadData();
    const timer = setInterval(() => void loadData(), 30_000);
    return () => clearInterval(timer);
  }, [loadData]);

  const dashboard = dashboards.find((d) => d.id === selected) ?? null;
  const channel = channels.find((c) => c.id === dashboard?.channel_id);

  async function create() {
    setBusy(true);
    try {
      const made = await api.monitor.createDashboard({
        name: newName,
        layout: { widgets: [] },
        is_default: dashboards.length === 0,
        channel_id: null,
      });
      setAdding(false);
      setNewName("");
      await loadList();
      setSelected(made.id);
      setEditing(made);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function share(revoke: boolean) {
    if (!dashboard) return;
    try {
      await api.monitor.shareDashboard(dashboard.id, revoke);
      await loadList();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function makeDefault() {
    if (!dashboard) return;
    try {
      await api.monitor.updateDashboard(dashboard.id, {
        name: dashboard.name,
        layout: dashboard.layout,
        is_default: true,
        channel_id: dashboard.channel_id,
      });
      await loadList();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function remove() {
    if (!dashboard || !window.confirm(`Delete the dashboard "${dashboard.name}"?`)) return;
    try {
      await api.monitor.deleteDashboard(dashboard.id);
      setSelected(null);
      await loadList();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const publicUrl = dashboard?.public_token
    ? `${window.location.origin}/view/${dashboard.public_token}`
    : "";

  return (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="toolbar">
        <Select aria-label="Dashboard" value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
          {dashboards.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.is_default ? " (default)" : ""}
            </option>
          ))}
        </Select>
        <button type="button" className="secondary" onClick={() => setAdding(true)}>
          New dashboard
        </button>
        {dashboard && (
          <>
            <button type="button" className="secondary" onClick={() => setEditing(dashboard)}>
              Design
            </button>
            {!dashboard.is_default && (
              <button type="button" className="secondary" onClick={() => void makeDefault()}>
                Make default
              </button>
            )}
            {dashboard.public_token ? (
              <>
                <a className="button-link" href={publicUrl} target="_blank" rel="noreferrer">
                  Open full screen
                </a>
                <button type="button" className="secondary" onClick={() => void share(true)}>
                  Stop sharing
                </button>
              </>
            ) : (
              <button type="button" className="secondary" onClick={() => void share(false)}>
                Share as a link
              </button>
            )}
            {channel?.subscribe_url && (
              <button type="button" className="secondary" onClick={() => setShowQr(true)}>
                Alerts on a phone
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="danger" onClick={() => void remove()}>
              Delete
            </button>
          </>
        )}
      </div>
      {dashboard?.public_token && (
        <p className="muted">
          Anyone with this link sees the dashboard, with no sign-in: <code>{publicUrl}</code>
        </p>
      )}

      {!dashboard && !error && <Loading label="Loading dashboards…" />}
      {dashboard && <DashboardGrid widgets={dashboard.layout.widgets} data={data} />}

      {adding && (
        <Modal
          title="New dashboard"
          submitLabel="Create"
          busy={busy}
          onSubmit={() => void create()}
          onClose={() => setAdding(false)}
        >
          <Field label="Name">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="File servers" />
          </Field>
        </Modal>
      )}
      {editing && (
        <Designer
          dashboard={editing}
          channels={channels}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await loadList();
            await loadData();
          }}
        />
      )}
      {showQr && channel?.subscribe_url && (
        <Modal
          title={`Alerts for “${dashboard?.name}” on your phone`}
          submitLabel="Done"
          onSubmit={() => setShowQr(false)}
          onClose={() => setShowQr(false)}
        >
          <p>
            Scan with the ntfy app. The phone then receives every alert sent to the channel{" "}
            <strong>{channel.name}</strong>; rules choose which alerts go there.
          </p>
          <div className="qr-holder">
            <QrCode value={channel.subscribe_url} label="Subscribe to the alert channel" />
          </div>
          <p className="muted mono">{channel.subscribe_url}</p>
        </Modal>
      )}
    </>
  );
}

const BLANK_WIDGET: DashboardWidget = {
  id: "",
  type: "chart",
  title: "",
  w: 6,
  h: 2,
  metric: "cpu_percent",
  scope_kind: "all",
  scope: "",
  hours: 6,
};

/**
 * The designer: the dashboard's widgets as a list with the same grid drawn
 * beside it, so a change is seen before it is saved. No drag and drop — a
 * widget moves up or down, grows or shrinks, and that is enough for a wall.
 */
function Designer({
  dashboard,
  channels,
  groups,
  onClose,
  onSaved,
}: {
  dashboard: MonitorDashboard;
  channels: MonitorChannel[];
  groups: MonitorGroup[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(dashboard.name);
  const [channelId, setChannelId] = useState(dashboard.channel_id ?? "");
  const [widgets, setWidgets] = useState<DashboardWidget[]>(dashboard.layout.widgets);
  const [draft, setDraft] = useState<DashboardWidget | null>(null);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [hosts, setHosts] = useState<MonitorHost[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.monitor
      .hosts()
      .then((r) => setHosts(r.hosts.filter((host) => !host.probe_only)))
      .catch(() => undefined);
  }, [dashboard.id]);

  function move(index: number, by: number) {
    setWidgets((was) => {
      const next = [...was];
      const target = index + by;
      if (target < 0 || target >= next.length) return was;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function commitDraft() {
    if (!draft) return;
    const widget = { ...draft, id: draft.id || `w${Date.now().toString(36)}` };
    setWidgets((was) =>
      editIndex === null ? [...was, widget] : was.map((w, i) => (i === editIndex ? widget : w)),
    );
    setDraft(null);
    setEditIndex(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.monitor.updateDashboard(dashboard.id, {
        name,
        layout: { widgets },
        is_default: dashboard.is_default,
        channel_id: channelId || null,
      });
      await onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Design dashboard" submitLabel="Save" busy={busy} error={error} onSubmit={() => void save()} onClose={onClose} wide>
      <div className="designer">
        <div className="designer-side full">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Alert channel shown with this dashboard" hint="The channel whose code the Alerts on a phone button shows">
            <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              <option value="">None</option>
              {channels
                .filter((c) => c.kind === "ntfy")
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          </Field>

          <h3 className="section-title">Widgets</h3>
          <ul className="widget-list">
            {widgets.map((widget, index) => (
              <li key={widget.id}>
                <span className="widget-list-name">
                  {widget.title || (widget.metric ? metricMeta(widget.metric).label : widget.type)}
                  <span className="muted"> · {widget.type} · {widget.w}/12</span>
                </span>
                <span className="widget-list-tools">
                  <button type="button" className="small secondary" onClick={() => move(index, -1)} aria-label="Move up">↑</button>
                  <button type="button" className="small secondary" onClick={() => move(index, 1)} aria-label="Move down">↓</button>
                  <button type="button" className="small secondary" onClick={() => { setDraft(widget); setEditIndex(index); }}>Edit</button>
                  <button type="button" className="small danger" onClick={() => setWidgets((was) => was.filter((_, i) => i !== index))}>Remove</button>
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="secondary" onClick={() => { setDraft({ ...BLANK_WIDGET }); setEditIndex(null); }}>
            Add widget
          </button>

          {draft && (
            <div className="widget-form">
              <Field label="Type">
                <Select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as DashboardWidget["type"] })}>
                  <option value="chart">Chart over time</option>
                  <option value="stat">Current value</option>
                  <option value="hosts">Machine table</option>
                  <option value="alerts">Open alerts</option>
                  <option value="text">Text</option>
                </Select>
              </Field>
              <Field label="Title">
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </Field>
              {(draft.type === "chart" || draft.type === "stat") && (
                <>
                  <Field label="Metric">
                    <Select value={draft.metric ?? ""} onChange={(e) => setDraft({ ...draft, metric: e.target.value })}>
                      {METRIC_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {draft.metric?.endsWith(":") && (
                    <p className="muted">
                      Add a mount point to narrow it, e.g. <code>disk_percent:/srv</code>: <input className="mono" value={draft.metric} onChange={(e) => setDraft({ ...draft, metric: e.target.value })} />
                    </p>
                  )}
                  <Field label="Which machines">
                    <Select value={draft.scope_kind ?? "all"} onChange={(e) => setDraft({ ...draft, scope_kind: e.target.value as DashboardWidget["scope_kind"], scope: "" })}>
                      <option value="all">Every machine</option>
                      <option value="group">A group</option>
                      <option value="host">One machine</option>
                    </Select>
                  </Field>
                  {draft.scope_kind === "group" && (
                    <Field label="Group">
                      <Select value={draft.scope ?? ""} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
                        <option value="">Choose…</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>{g.name}</option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {draft.scope_kind === "host" && (
                    <Field label="Machine">
                      <Select value={draft.scope ?? ""} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
                        <option value="">Choose…</option>
                        {hosts.map((h) => (
                          <option key={h.host} value={h.host}>{h.host}</option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {draft.type === "chart" && (
                    <Field label="Hours shown">
                      <input type="number" min={1} max={336} value={draft.hours ?? 6} onChange={(e) => setDraft({ ...draft, hours: Number(e.target.value) })} />
                    </Field>
                  )}
                </>
              )}
              {draft.type === "text" && (
                <Field label="Text">
                  <textarea value={draft.text ?? ""} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
                </Field>
              )}
              <div className="field-row">
                <Field label="Width">
                  <Select value={String(draft.w)} onChange={(e) => setDraft({ ...draft, w: Number(e.target.value) as DashboardWidget["w"] })}>
                    <option value="3">¼</option>
                    <option value="4">⅓</option>
                    <option value="6">½</option>
                    <option value="8">⅔</option>
                    <option value="12">Full</option>
                  </Select>
                </Field>
                <Field label="Height">
                  <Select value={String(draft.h)} onChange={(e) => setDraft({ ...draft, h: Number(e.target.value) as DashboardWidget["h"] })}>
                    <option value="1">Short</option>
                    <option value="2">Medium</option>
                    <option value="3">Tall</option>
                  </Select>
                </Field>
              </div>
              <div className="dialog-actions inline">
                <button type="button" className="secondary" onClick={() => { setDraft(null); setEditIndex(null); }}>Cancel</button>
                <button type="button" className="primary" onClick={commitDraft} disabled={(draft.type === "chart" || draft.type === "stat") && !draft.metric}>
                  {editIndex === null ? "Add" : "Apply"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------- hosts --

function HostsTab() {
  const [loaded, setLoaded] = useState(false);
  const [hosts, setHosts] = useState<MonitorHost[]>([]);
  const [groups, setGroups] = useState<MonitorGroup[]>([]);
  const [editing, setEditing] = useState<Partial<MonitorGroup> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [h, g] = await Promise.all([api.monitor.hosts(), api.monitor.groups()]);
      setHosts(h.hosts.filter((host) => !host.probe_only));
      setGroups(g.groups);
    setLoaded(true);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  async function save() {
    if (!editing?.name) return;
    setBusy(true);
    try {
      const body = { name: editing.name, description: editing.description ?? "", members: editing.members ?? [] };
      if (editing.id) await api.monitor.updateGroup(editing.id, body);
      else await api.monitor.createGroup(body);
      setEditing(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(group: MonitorGroup) {
    if (!window.confirm(`Delete the group "${group.name}"? Rules and windows scoped to it will cover nothing.`)) return;
    try {
      await api.monitor.deleteGroup(group.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      <h3 className="section-title">Machines</h3>
      {!loaded ? <Loading /> : <HostsWidget hosts={hosts} />}

      <div className="toolbar" style={{ marginTop: 18 }}>
        <h3 className="section-title" style={{ margin: 0 }}>Groups</h3>
        <span className="spacer" />
        <button type="button" className="secondary" onClick={() => setEditing({ name: "", description: "", members: [] })}>
          New group
        </button>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Group</th>
            <th scope="col">Members</th>
            <th scope="col">Description</th>
            <th scope="col" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.id}>
              <td>{group.name}</td>
              <td className="mono">{group.members.map((m) => m.split(".")[0]).join(", ") || "—"}</td>
              <td>{group.description}</td>
              <td className="row-actions">
                <button type="button" className="small secondary" onClick={() => setEditing(group)}>Edit</button>
                <button type="button" className="small danger" onClick={() => void remove(group)}>Delete</button>
              </td>
            </tr>
          ))}
          {!loaded && <LoadingRow colSpan={4} />}
          {loaded && groups.length === 0 && (
            <tr><td colSpan={4} className="empty">No groups. A rule, a window or a chart can name every machine, one machine, or a group.</td></tr>
          )}
        </tbody>
      </table>

      {editing && (
        <Modal title={editing.id ? "Edit group" : "New group"} submitLabel="Save" busy={busy} onSubmit={() => void save()} onClose={() => setEditing(null)}>
          <Field label="Name">
            <input value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="File servers" />
          </Field>
          <Field label="Description">
            <input value={editing.description ?? ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          </Field>
          <Field label="Members">
            <div className="checkbox-list">
              {hosts.map((host) => (
                <label key={host.host} className="checkbox">
                  <input
                    type="checkbox"
                    checked={(editing.members ?? []).includes(host.host)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        members: e.target.checked
                          ? [...(editing.members ?? []), host.host]
                          : (editing.members ?? []).filter((m) => m !== host.host),
                      })
                    }
                  />
                  {host.host}
                </label>
              ))}
              {hosts.length === 0 && <p className="muted">No machine has reported yet.</p>}
            </div>
          </Field>
        </Modal>
      )}
    </>
  );
}

// ------------------------------------------------------------------- alerts --

function AlertsTab() {
  const [loaded, setLoaded] = useState(false);
  const [alerts, setAlerts] = useState<MonitorAlert[]>([]);
  const [state, setState] = useState<"firing" | "resolved" | "all">("firing");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAlerts((await api.monitor.alerts(state)).alerts);
    setLoaded(true);
    } catch (err) {
      setError(describeError(err));
    }
  }, [state]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      <div className="toolbar">
        <Select aria-label="Which alerts" value={state} onChange={(e) => setState(e.target.value as typeof state)}>
          <option value="firing">Open</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </Select>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Since</th>
            <th scope="col">Severity</th>
            <th scope="col">Rule</th>
            <th scope="col">Machine</th>
            <th scope="col">What</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((alert) => (
            <tr key={alert.id}>
              <td className="nowrap">{new Date(alert.started_at).toLocaleString()}</td>
              <td><span className={`badge ${alert.severity === "critical" ? "failure" : ""}`}>{alert.severity}</span></td>
              <td>{alert.rule_name}</td>
              <td>{alert.host.split(".")[0]}</td>
              <td>{alert.message}{alert.suppressed && <span className="muted"> · in maintenance, nobody told</span>}</td>
              <td>{alert.state === "firing" ? <span className="badge failure">firing</span> : <span className="badge success">resolved {alert.resolved_at && new Date(alert.resolved_at).toLocaleTimeString()}</span>}</td>
            </tr>
          ))}
          {!loaded && <LoadingRow colSpan={6} />}
          {loaded && alerts.length === 0 && <tr><td colSpan={6} className="empty">Nothing here.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

// -------------------------------------------------------------------- rules --

const BLANK_RULE: Omit<MonitorRule, "id"> = {
  name: "",
  description: "",
  metric: "cpu_percent",
  op: "gt",
  threshold: 90,
  for_seconds: 300,
  severity: "warning",
  scope_kind: "all",
  scope: "",
  channels: [],
  enabled: true,
};

function RulesTab() {
  const [loaded, setLoaded] = useState(false);
  const [rules, setRules] = useState<MonitorRule[]>([]);
  const [groups, setGroups] = useState<MonitorGroup[]>([]);
  const [channels, setChannels] = useState<MonitorChannel[]>([]);
  const [hosts, setHosts] = useState<MonitorHost[]>([]);
  const [editing, setEditing] = useState<(Omit<MonitorRule, "id"> & { id?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, g, c, h] = await Promise.all([api.monitor.rules(), api.monitor.groups(), api.monitor.channels(), api.monitor.hosts()]);
      setRules(r.rules);
      setGroups(g.groups);
      setChannels(c.channels);
      setHosts(h.hosts);
    setLoaded(true);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const channelName = useMemo(() => new Map(channels.map((c) => [c.id, c.name])), [channels]);

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      const { id, ...body } = editing;
      if (id) await api.monitor.updateRule(id, body);
      else await api.monitor.createRule(body);
      setEditing(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: MonitorRule) {
    if (!window.confirm(`Delete the rule "${rule.name}"?`)) return;
    try {
      await api.monitor.deleteRule(rule.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      <div className="toolbar">
        <span className="spacer" />
        <button type="button" className="secondary" onClick={() => setEditing({ ...BLANK_RULE })}>New rule</button>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Rule</th>
            <th scope="col">Condition</th>
            <th scope="col">For</th>
            <th scope="col">Severity</th>
            <th scope="col">Where</th>
            <th scope="col">Tells</th>
            <th scope="col" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {!loaded && <LoadingRow colSpan={7} />}
          {loaded && rules.map((rule) => (
            <tr key={rule.id} className={rule.enabled ? "" : "muted"}>
              <td>{rule.name}{!rule.enabled && <span className="badge">off</span>}<br /><span className="muted">{rule.description}</span></td>
              <td className="mono">{metricMeta(rule.metric).label} {rule.op === "gt" ? ">" : "<"} {rule.threshold}</td>
              <td>{minutes(rule.for_seconds)}</td>
              <td><span className={`badge ${rule.severity === "critical" ? "failure" : ""}`}>{rule.severity}</span></td>
              <td>{rule.scope_kind === "all" ? "every machine" : rule.scope_kind === "group" ? groupName.get(rule.scope) ?? "(deleted group)" : rule.scope}</td>
              <td>{rule.channels.map((c) => channelName.get(c) ?? "?").join(", ") || <span className="muted">nobody</span>}</td>
              <td className="row-actions">
                <button type="button" className="small secondary" onClick={() => setEditing(rule)}>Edit</button>
                <button type="button" className="small danger" onClick={() => void remove(rule)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <Modal title={editing.id ? "Edit rule" : "New rule"} submitLabel="Save" busy={busy} onSubmit={() => void save()} onClose={() => setEditing(null)}>
          <Field label="Name">
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          <Field label="Description">
            <input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          </Field>
          <Field label="Metric" hint="A family (each) alerts once per series — per filesystem, say. Narrow it by typing e.g. disk_percent:/srv">
            <Select value={METRIC_OPTIONS.some((o) => o.value === editing.metric) ? editing.metric : "custom"} onChange={(e) => e.target.value !== "custom" && setEditing({ ...editing, metric: e.target.value })}>
              {METRIC_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              <option value="custom">Typed below</option>
            </Select>
            <input className="mono" value={editing.metric} onChange={(e) => setEditing({ ...editing, metric: e.target.value })} />
          </Field>
          <div className="field-row">
            <Field label="Fires when">
              <Select value={editing.op} onChange={(e) => setEditing({ ...editing, op: e.target.value as "gt" | "lt" })}>
                <option value="gt">over</option>
                <option value="lt">under</option>
              </Select>
            </Field>
            <Field label="Threshold">
              <input type="number" step="any" value={editing.threshold} onChange={(e) => setEditing({ ...editing, threshold: Number(e.target.value) })} />
            </Field>
            <Field label="For (seconds)" hint="0 fires at once">
              <input type="number" min={0} max={86400} value={editing.for_seconds} onChange={(e) => setEditing({ ...editing, for_seconds: Number(e.target.value) })} />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Severity">
              <Select value={editing.severity} onChange={(e) => setEditing({ ...editing, severity: e.target.value as "warning" | "critical" })}>
                <option value="warning">warning</option>
                <option value="critical">critical</option>
              </Select>
            </Field>
            <Field label="Where">
              <Select value={editing.scope_kind} onChange={(e) => setEditing({ ...editing, scope_kind: e.target.value as MonitorRule["scope_kind"], scope: "" })}>
                <option value="all">Every machine</option>
                <option value="group">A group</option>
                <option value="host">One machine</option>
              </Select>
            </Field>
          </div>
          {editing.scope_kind === "group" && (
            <Field label="Group">
              <Select value={editing.scope} onChange={(e) => setEditing({ ...editing, scope: e.target.value })}>
                <option value="">Choose…</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </Select>
            </Field>
          )}
          {editing.scope_kind === "host" && (
            <Field label="Machine">
              <Select value={editing.scope} onChange={(e) => setEditing({ ...editing, scope: e.target.value })}>
                <option value="">Choose…</option>
                {hosts.map((h) => <option key={h.host} value={h.host}>{h.host}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Tell">
            <div className="checkbox-list">
              {channels.map((c) => (
                <label key={c.id} className="checkbox">
                  <input type="checkbox" checked={editing.channels.includes(c.id)} onChange={(e) => setEditing({ ...editing, channels: e.target.checked ? [...editing.channels, c.id] : editing.channels.filter((x) => x !== c.id) })} />
                  {c.name} <span className="muted">({c.kind}{c.min_severity === "critical" ? ", critical only" : ""})</span>
                </label>
              ))}
              {channels.length === 0 && <p className="muted">No channels yet — the alert is recorded but nobody is told.</p>}
            </div>
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
            Enabled
          </label>
        </Modal>
      )}
    </>
  );
}

// ----------------------------------------------------------------- channels --

function ChannelsTab() {
  const [loaded, setLoaded] = useState(false);
  const [channels, setChannels] = useState<MonitorChannel[]>([]);
  const [adding, setAdding] = useState<{ name: string; kind: "ntfy" | "webhook"; url: string; min_severity: "warning" | "critical" } | null>(null);
  const [qr, setQr] = useState<MonitorChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setChannels((await api.monitor.channels()).channels);
    setLoaded(true);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function save() {
    if (!adding) return;
    setBusy(true);
    try {
      await api.monitor.createChannel(adding);
      setAdding(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function test(channel: MonitorChannel) {
    setNotice(null);
    try {
      await api.monitor.testChannel(channel.id);
      setNotice(`A test went to ${channel.name}.`);
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function remove(channel: MonitorChannel) {
    if (!window.confirm(`Delete the channel "${channel.name}"? Rules naming it tell nobody.`)) return;
    try {
      await api.monitor.deleteChannel(channel.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <div className="toolbar">
        <span className="spacer" />
        <button type="button" className="secondary" onClick={() => setAdding({ name: "", kind: "ntfy", url: "", min_severity: "warning" })}>New channel</button>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Channel</th>
            <th scope="col">Kind</th>
            <th scope="col">Takes</th>
            <th scope="col">Where</th>
            <th scope="col" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {channels.map((channel) => (
            <tr key={channel.id}>
              <td>{channel.name}</td>
              <td>{channel.kind}</td>
              <td>{channel.min_severity === "critical" ? "critical only" : "warnings and critical"}</td>
              <td className="mono">{channel.kind === "ntfy" ? (channel.available ? channel.topic : "phone approvals are not set up on the controller") : channel.url}</td>
              <td className="row-actions">
                {channel.kind === "ntfy" && channel.subscribe_url && <button type="button" className="small secondary" onClick={() => setQr(channel)}>Scan</button>}
                <button type="button" className="small secondary" onClick={() => void test(channel)}>Send test</button>
                <button type="button" className="small danger" onClick={() => void remove(channel)}>Delete</button>
              </td>
            </tr>
          ))}
          {!loaded && <LoadingRow colSpan={5} />}
          {loaded && channels.length === 0 && <tr><td colSpan={5} className="empty">No channels. Alerts are recorded either way; a channel is who hears about them.</td></tr>}
        </tbody>
      </table>

      {adding && (
        <Modal title="New channel" submitLabel="Create" busy={busy} onSubmit={() => void save()} onClose={() => setAdding(null)}>
          <Field label="Name">
            <input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="On-call phone" />
          </Field>
          <Field label="Kind">
            <Select value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value as "ntfy" | "webhook" })}>
              <option value="ntfy">Phone (ntfy) — a topic with a code to scan</option>
              <option value="webhook">Webhook — JSON posted to a URL</option>
            </Select>
          </Field>
          {adding.kind === "webhook" && (
            <Field label="URL">
              <input value={adding.url} onChange={(e) => setAdding({ ...adding, url: e.target.value })} placeholder="https://chat.example.org/hooks/…" />
            </Field>
          )}
          <Field label="Takes">
            <Select value={adding.min_severity} onChange={(e) => setAdding({ ...adding, min_severity: e.target.value as "warning" | "critical" })}>
              <option value="warning">Warnings and critical</option>
              <option value="critical">Critical only</option>
            </Select>
          </Field>
        </Modal>
      )}
      {qr && qr.subscribe_url && (
        <Modal title={`Subscribe a phone to “${qr.name}”`} submitLabel="Done" onSubmit={() => setQr(null)} onClose={() => setQr(null)}>
          <p>Scan with the ntfy app — the one the domain ships for sign-in approvals works.</p>
          <div className="qr-holder"><QrCode value={qr.subscribe_url} label="Subscribe to the channel" /></div>
          <p className="muted mono">{qr.subscribe_url}</p>
        </Modal>
      )}
    </>
  );
}

// -------------------------------------------------------------- maintenance --

function localInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function MaintenanceTab() {
  const [loaded, setLoaded] = useState(false);
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);
  const [groups, setGroups] = useState<MonitorGroup[]>([]);
  const [hosts, setHosts] = useState<MonitorHost[]>([]);
  const [adding, setAdding] = useState<{ name: string; scope_kind: "all" | "group" | "host"; scope: string; starts_at: string; ends_at: string; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, g, h] = await Promise.all([api.monitor.maintenance(), api.monitor.groups(), api.monitor.hosts()]);
      setWindows(w.windows);
      setGroups(g.groups);
      setHosts(h.hosts);
    setLoaded(true);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

  async function save() {
    if (!adding) return;
    setBusy(true);
    try {
      await api.monitor.createMaintenance({
        ...adding,
        starts_at: new Date(adding.starts_at).toISOString(),
        ends_at: new Date(adding.ends_at).toISOString(),
      });
      setAdding(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(window_: MaintenanceWindow) {
    try {
      await api.monitor.deleteMaintenance(window_.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const now = Date.now();
  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      <p className="muted">During a window, alerts for its machines are still recorded but nobody is told. Planned work is not an incident.</p>
      <div className="toolbar">
        <span className="spacer" />
        <button type="button" className="secondary" onClick={() => setAdding({ name: "", scope_kind: "all", scope: "", starts_at: localInput(new Date()), ends_at: localInput(new Date(now + 2 * 3_600_000)), note: "" })}>New window</button>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Window</th>
            <th scope="col">Where</th>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">State</th>
            <th scope="col" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {windows.map((w) => {
            const starts = new Date(w.starts_at).getTime();
            const ends = new Date(w.ends_at).getTime();
            const state = now < starts ? "planned" : now > ends ? "over" : "active";
            return (
              <tr key={w.id}>
                <td>{w.name}<br /><span className="muted">{w.note}</span></td>
                <td>{w.scope_kind === "all" ? "every machine" : w.scope_kind === "group" ? groupName.get(w.scope) ?? "(deleted group)" : w.scope}</td>
                <td className="nowrap">{new Date(w.starts_at).toLocaleString()}</td>
                <td className="nowrap">{new Date(w.ends_at).toLocaleString()}</td>
                <td><span className={`badge ${state === "active" ? "success" : ""}`}>{state}</span></td>
                <td className="row-actions"><button type="button" className="small danger" onClick={() => void remove(w)}>Delete</button></td>
              </tr>
            );
          })}
          {!loaded && <LoadingRow colSpan={6} />}
          {loaded && windows.length === 0 && <tr><td colSpan={6} className="empty">No windows.</td></tr>}
        </tbody>
      </table>

      {adding && (
        <Modal title="New maintenance window" submitLabel="Create" busy={busy} onSubmit={() => void save()} onClose={() => setAdding(null)}>
          <Field label="Name"><input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="Kernel updates" /></Field>
          <Field label="Where">
            <Select value={adding.scope_kind} onChange={(e) => setAdding({ ...adding, scope_kind: e.target.value as typeof adding.scope_kind, scope: "" })}>
              <option value="all">Every machine</option>
              <option value="group">A group</option>
              <option value="host">One machine</option>
            </Select>
          </Field>
          {adding.scope_kind === "group" && (
            <Field label="Group"><Select value={adding.scope} onChange={(e) => setAdding({ ...adding, scope: e.target.value })}><option value="">Choose…</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
          )}
          {adding.scope_kind === "host" && (
            <Field label="Machine"><Select value={adding.scope} onChange={(e) => setAdding({ ...adding, scope: e.target.value })}><option value="">Choose…</option>{hosts.map((h) => <option key={h.host} value={h.host}>{h.host}</option>)}</Select></Field>
          )}
          <div className="field-row">
            <Field label="From"><input type="datetime-local" value={adding.starts_at} onChange={(e) => setAdding({ ...adding, starts_at: e.target.value })} /></Field>
            <Field label="To"><input type="datetime-local" value={adding.ends_at} onChange={(e) => setAdding({ ...adding, ends_at: e.target.value })} /></Field>
          </div>
          <Field label="Note"><input value={adding.note} onChange={(e) => setAdding({ ...adding, note: e.target.value })} /></Field>
        </Modal>
      )}
    </>
  );
}

// ------------------------------------------------------------------- probes --

function ProbesTab() {
  const [loaded, setLoaded] = useState(false);
  const [probes, setProbes] = useState<MonitorProbe[]>([]);
  const [nodes, setNodes] = useState<string[]>([]);
  const [editing, setEditing] = useState<(Omit<MonitorProbe, "id"> & { id?: string }) | null>(null);
  const [latest, setLatest] = useState<MonitorHost[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, o, h] = await Promise.all([api.monitor.probes(), api.monitor.overview(), api.monitor.hosts()]);
      setProbes(p.probes);
      setNodes(o.probing_nodes);
      setLatest(h.hosts);
    setLoaded(true);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const status = useMemo(() => {
    const map = new Map<string, MonitorHost>();
    for (const host of latest) map.set(host.host, host);
    return map;
  }, [latest]);

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      const { id, ...body } = editing;
      if (id) await api.monitor.updateProbe(id, body);
      else await api.monitor.createProbe(body);
      setEditing(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(probe: MonitorProbe) {
    if (!window.confirm(`Delete the probe "${probe.name}"?`)) return;
    try {
      await api.monitor.deleteProbe(probe.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  function targetHost(probe: MonitorProbe): string {
    if (probe.kind !== "http") return probe.target.toLowerCase();
    try {
      return new URL(probe.target).hostname.toLowerCase();
    } catch {
      return probe.target;
    }
  }

  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      <p className="muted">
        Run from {nodes.length ? nodes.map((n) => n.split(".")[0]).join(", ") : "the machine carrying the monitoring role"} against things with no agent of their own: a switch, a printer, a web page.
      </p>
      <div className="toolbar">
        <span className="spacer" />
        <button type="button" className="secondary" onClick={() => setEditing({ name: "", kind: "ping", target: "", port: 0, interval_seconds: 60, enabled: true })}>New probe</button>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Probe</th>
            <th scope="col">Check</th>
            <th scope="col">Every</th>
            <th scope="col">Answering</th>
            <th scope="col">Latency</th>
            <th scope="col" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {probes.map((probe) => {
            const seen = status.get(targetHost(probe));
            const suffix = `:${probe.kind}${probe.port ? `-${probe.port}` : ""}`;
            const up = seen?.metrics[`probe_up${suffix}`];
            return (
              <tr key={probe.id} className={probe.enabled ? "" : "muted"}>
                <td>{probe.name}{!probe.enabled && <span className="badge">off</span>}</td>
                <td className="mono">{probe.kind} {probe.target}{probe.port ? `:${probe.port}` : ""}</td>
                <td>{minutes(probe.interval_seconds)}</td>
                <td>{up === undefined ? <span className="muted">not yet</span> : up === 1 ? <span className="badge success">yes</span> : <span className="badge failure">no</span>}</td>
                <td>{formatValue(seen?.metrics[`probe_latency_ms${suffix}`], "ms")}</td>
                <td className="row-actions">
                  <button type="button" className="small secondary" onClick={() => setEditing(probe)}>Edit</button>
                  <button type="button" className="small danger" onClick={() => void remove(probe)}>Delete</button>
                </td>
              </tr>
            );
          })}
          {!loaded && <LoadingRow colSpan={6} />}
          {loaded && probes.length === 0 && <tr><td colSpan={6} className="empty">No probes.</td></tr>}
        </tbody>
      </table>

      {editing && (
        <Modal title={editing.id ? "Edit probe" : "New probe"} submitLabel="Save" busy={busy} onSubmit={() => void save()} onClose={() => setEditing(null)}>
          <Field label="Name"><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Core switch" /></Field>
          <Field label="Check">
            <Select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as MonitorProbe["kind"] })}>
              <option value="ping">Ping</option>
              <option value="tcp">TCP port opens</option>
              <option value="http">HTTP answers</option>
            </Select>
          </Field>
          <Field label={editing.kind === "http" ? "URL" : "Host or address"}>
            <input value={editing.target} onChange={(e) => setEditing({ ...editing, target: e.target.value })} placeholder={editing.kind === "http" ? "https://intranet.corp.example.internal/" : "switch-01.corp.example.internal"} />
          </Field>
          {editing.kind === "tcp" && (
            <Field label="Port"><input type="number" min={1} max={65535} value={editing.port || ""} onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) })} /></Field>
          )}
          <Field label="Every (seconds)"><input type="number" min={10} max={3600} value={editing.interval_seconds} onChange={(e) => setEditing({ ...editing, interval_seconds: Number(e.target.value) })} /></Field>
          <label className="checkbox"><input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> Enabled</label>
        </Modal>
      )}
    </>
  );
}
