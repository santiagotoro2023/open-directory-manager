import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ClipboardList, Plus, Trash2 } from "lucide-react";
import { ApiError, api, type Gpo, type GpoLink, type PolicySettings } from "../api";
import { Field, Modal } from "../components/Modal";
import { SettingsEditor } from "../components/SettingsEditor";
import { TemplateManager } from "../components/TemplateManager";

type Tab = "settings" | "links" | "scope";

export function Policy() {
  const [gpos, setGpos] = useState<Gpo[]>([]);
  const [selected, setSelected] = useState<Gpo | null>(null);
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setGpos((await api.policy.list()).gpos);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(guid: string) {
    try {
      setSelected(await api.policy.get(guid));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  if (selected) {
    return (
      <GpoDetail
        gpo={selected}
        onClose={() => {
          setSelected(null);
          void load();
        }}
        onReload={() => void open(selected.guid)}
      />
    );
  }

  return (
    <main className="content">
      <div className="toolbar">
        <h1>Group Policy Objects</h1>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => setTemplates(true)}>
          Administrative templates
        </button>
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          <Plus size={15} aria-hidden="true" />
          New GPO
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
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Links</th>
            <th scope="col">Version</th>
            <th scope="col">Description</th>
          </tr>
        </thead>
        <tbody>
          {gpos.map((gpo) => (
            <tr key={gpo.guid} onClick={() => void open(gpo.guid)}>
              <td>
                <ClipboardList size={15} aria-hidden="true" />
                {gpo.display_name}
              </td>
              <td>{gpo.enabled ? "Enabled" : <span className="badge">Disabled</span>}</td>
              <td>{gpo.link_count ?? 0}</td>
              <td>{gpo.version}</td>
              <td>{gpo.description}</td>
            </tr>
          ))}
          {gpos.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No group policy objects yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {templates && <TemplateManager onClose={() => setTemplates(false)} />}

      {creating && (
        <CreateGpoDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </main>
  );
}

function CreateGpoDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="New group policy object"
      submitLabel="Create"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.policy.create(name, description);
          onCreated();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name">
        <input value={name} required onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </Modal>
  );
}

function GpoDetail({
  gpo,
  onClose,
  onReload,
}: {
  gpo: Gpo;
  onClose: () => void;
  onReload: () => void;
}) {
  const [tab, setTab] = useState<Tab>("settings");
  const [settings, setSettings] = useState<PolicySettings>(gpo.settings);
  const [name, setName] = useState(gpo.display_name);
  const [description, setDescription] = useState(gpo.description);
  const [enabled, setEnabled] = useState(gpo.enabled);
  const [filter, setFilter] = useState(gpo.security_filter.join("\n"));
  const [hostname, setHostname] = useState(gpo.targeting.hostname_pattern ?? "");
  const [osList, setOsList] = useState((gpo.targeting.os ?? []).join(", "));
  const [ipRanges, setIpRanges] = useState((gpo.targeting.ip_ranges ?? []).join(", "));
  const [groups, setGroups] = useState((gpo.targeting.security_groups ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const lines = (value: string) =>
    value
      .split(/[\n,]/)
      .map((part) => part.trim())
      .filter(Boolean);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.policy.update({
        guid: gpo.guid,
        display_name: name,
        description,
        enabled,
        settings,
        security_filter: lines(filter),
        targeting: {
          os: lines(osList),
          hostname_pattern: hostname || undefined,
          security_groups: lines(groups),
          ip_ranges: lines(ipRanges),
        },
      });
      setSaved(true);
      onReload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="content">
      <div className="toolbar">
        <button type="button" className="ghost" onClick={onClose}>
          Back
        </button>
        <h1>{gpo.display_name}</h1>
        <span className="spacer" />
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
          Save
        </button>
      </div>
      <p className="mono muted">{gpo.guid}</p>

      <nav className="tabs" aria-label="Group policy sections">
        {(["settings", "links", "scope"] as Tab[]).map((current) => (
          <button
            key={current}
            type="button"
            className={tab === current ? "tab active" : "tab"}
            aria-current={tab === current ? "true" : undefined}
            onClick={() => setTab(current)}
          >
            {current === "settings" ? "Settings" : current === "links" ? "Links" : "Scope"}
          </button>
        ))}
      </nav>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {saved && <p className="muted">Saved. Agents pick this up on their next refresh.</p>}

      {tab === "settings" && <SettingsEditor settings={settings} onChange={setSettings} />}

      {tab === "links" && <LinksEditor gpo={gpo} onChanged={onReload} />}

      {tab === "scope" && (
        <div className="scope-form">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description">
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Group policy object enabled
          </label>

          <h3>Security filtering</h3>
          <Field
            label="Applies only to these principals"
            hint="One distinguished name per line. Empty means everyone."
          >
            <textarea rows={4} className="mono" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </Field>

          <h3>Item-level targeting</h3>
          <Field label="Operating systems" hint="Comma separated, e.g. debian-12, debian-13">
            <input value={osList} onChange={(e) => setOsList(e.target.value)} />
          </Field>
          <Field label="Host name pattern" hint="Shell-style wildcards, e.g. ws-*">
            <input value={hostname} onChange={(e) => setHostname(e.target.value)} />
          </Field>
          <Field label="IP ranges" hint="Comma separated CIDR, e.g. 10.10.0.0/16">
            <input value={ipRanges} onChange={(e) => setIpRanges(e.target.value)} />
          </Field>
          <Field label="Groups" hint="One distinguished name per line">
            <textarea rows={3} className="mono" value={groups} onChange={(e) => setGroups(e.target.value)} />
          </Field>
        </div>
      )}
    </main>
  );
}

function LinksEditor({ gpo, onChanged }: { gpo: Gpo; onChanged: () => void }) {
  const [links, setLinks] = useState<GpoLink[]>(gpo.links ?? []);
  const [containers, setContainers] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.directory
      .tree()
      .then((tree) => {
        const dns = tree.nodes.map((node) => node.distinguishedName);
        setContainers(dns);
        setTarget((current) => current || tree.base_dn);
      })
      .catch(() => setContainers([]));
  }, []);

  async function refresh() {
    const fresh = await api.policy.get(gpo.guid);
    setLinks(fresh.links ?? []);
    onChanged();
  }

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div>
      <div className="toolbar">
        <select
          aria-label="Container to link to"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          {containers.map((dn) => (
            <option key={dn} value={dn}>
              {dn}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ghost"
          onClick={() => void run(() => api.policy.link(gpo.guid, target))}
        >
          <Plus size={14} aria-hidden="true" />
          Link here
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
            <th scope="col" style={{ width: "90px" }}>
              Order
            </th>
            <th scope="col">Linked container</th>
            <th scope="col" style={{ width: "110px" }}>
              Enforced
            </th>
            <th scope="col" style={{ width: "110px" }}>
              Link enabled
            </th>
            <th scope="col" style={{ width: "120px" }}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {links.map((link) => (
            <tr key={link.id}>
              <td>{link.link_order}</td>
              <td className="mono">{link.target_dn}</td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Enforced on ${link.target_dn}`}
                  checked={link.enforced}
                  onChange={(e) =>
                    void run(() =>
                      api.policy.updateLink({ id: link.id, enforced: e.target.checked }),
                    )
                  }
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Link enabled on ${link.target_dn}`}
                  checked={link.enabled}
                  onChange={(e) =>
                    void run(() =>
                      api.policy.updateLink({ id: link.id, enabled: e.target.checked }),
                    )
                  }
                />
              </td>
              <td>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Raise precedence on ${link.target_dn}`}
                  disabled={link.link_order <= 1}
                  onClick={() =>
                    void run(() =>
                      api.policy.updateLink({ id: link.id, link_order: link.link_order - 1 }),
                    )
                  }
                >
                  <ArrowUp size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Lower precedence on ${link.target_dn}`}
                  onClick={() =>
                    void run(() =>
                      api.policy.updateLink({ id: link.id, link_order: link.link_order + 1 }),
                    )
                  }
                >
                  <ArrowDown size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Remove link to ${link.target_dn}`}
                  onClick={() => void run(() => api.policy.unlink(link.id))}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
          {links.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Not linked anywhere yet, so nothing receives it.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted">
        Link order 1 has the highest precedence at a container. Enforced links override anything
        set closer to the object and survive blocked inheritance.
      </p>
    </div>
  );
}
