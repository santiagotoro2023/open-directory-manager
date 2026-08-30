import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ClipboardList,
  Download,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { ApiError, api, type Gpo, type GpoLink, type PolicySettings } from "../api";
import { Field, Modal } from "../components/Modal";
import { useContextMenu } from "../components/ContextMenu";
import { ChoiceList, SUPPORTED_RELEASES } from "../components/ChoiceList";
import { ContainerPicker } from "../components/Picker";
import { SettingsEditor } from "../components/SettingsEditor";
import { TemplateManager } from "../components/TemplateManager";

type Tab = "settings" | "links" | "scope";

export function Policy() {
  const [gpos, setGpos] = useState<Gpo[]>([]);
  const [selected, setSelected] = useState<Gpo | null>(null);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { bind, menu } = useContextMenu();

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

  // Saved by the browser rather than shown: a policy object is something to
  // keep in a repository, not to read in a dialog.
  async function exportAll(guid?: string) {
    try {
      const document = await api.policy.export(guid);
      download(
        guid ? `gpo-${guid}.json` : "group-policy-export.json",
        JSON.stringify(document, null, 2),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

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
      <div className="page-header">
        <h1>Group Policy Objects</h1>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => setTemplates(true)}>
          Administrative templates
        </button>
        <button type="button" className="ghost" onClick={() => void exportAll()}>
          <Download size={15} aria-hidden="true" />
          Export all
        </button>
        <button type="button" className="ghost" onClick={() => setImporting(true)}>
          <Upload size={15} aria-hidden="true" />
          Import
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
            <tr
              key={gpo.guid}
              onClick={() => void open(gpo.guid)}
              {...bind([
                { label: gpo.display_name, heading: true },
                { label: "Edit settings…", onSelect: () => void open(gpo.guid) },
                { label: "Export…", onSelect: () => void exportAll(gpo.guid) },
                { separator: true },
                {
                  label: "Delete",
                  danger: true,
                  onSelect: async () => {
                    await api.policy.remove(gpo.guid).catch(() => undefined);
                    void load();
                  },
                },
              ])}
            >
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
              <td colSpan={5} className="empty">
                No group policy objects yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {menu}

      {templates && <TemplateManager onClose={() => setTemplates(false)} />}

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void load();
          }}
        />
      )}

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

function CreateGpoDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
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
  const [confirming, setConfirming] = useState(false);

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

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.policy.remove(gpo.guid);
      onClose();
    } catch (err) {
      // Gone already is the outcome that was asked for. Reporting it as a
      // failure left the operator on the page for an object that no longer
      // exists, with an error saying so and no way forward but the back
      // button.
      if (err instanceof ApiError && err.status === 404) {
        onClose();
        return;
      }
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="content">
      <div className="page-header">
        <button type="button" className="ghost" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden="true" />
          Back
        </button>
        <h1>{gpo.display_name}</h1>
        <span className="spacer" />
        <button type="button" className="danger" onClick={() => setConfirming(true)}>
          <Trash2 size={15} aria-hidden="true" />
          Delete
        </button>
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
          Save
        </button>
      </div>
      <p className="mono muted">{gpo.guid}</p>

      {confirming && (
        <Modal
          title={`Delete ${gpo.display_name}?`}
          submitLabel="Delete"
          busy={busy}
          onClose={() => setConfirming(false)}
          onSubmit={() => void remove()}
        >
          <p>
            {gpo.link_count
              ? `Linked in ${gpo.link_count} place${gpo.link_count === 1 ? "" : "s"}. Those links go with it.`
              : "This policy object is not linked anywhere."}
          </p>
          <p className="muted">Restorable from Deleted Objects within the retention window.</p>
        </Modal>
      )}

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
        /* Three groups side by side rather than one 720px column with two
           thirds of a wide screen left blank underneath it. */
        <div className="scope-form">
          <section>
            <h3>Identity</h3>
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
          </section>

          <section>
            <h3>Security filtering</h3>
            <div className="field">
              <span>Applies only to these</span>
              <ChoiceList
                kind="principal"
                values={lines(filter)}
                onChange={(next) => setFilter(next.join("\n"))}
                addLabel="Add a user or group…"
                emptyLabel="Everyone this policy object's links reach."
              />
            </div>
          </section>

          <section>
            <h3>Item-level targeting</h3>
            <div className="field">
              <span>Operating systems</span>
              <div className="option-row">
                {SUPPORTED_RELEASES.map((release) => (
                  <label key={release.value} className="checkbox">
                    <input
                      type="checkbox"
                      checked={lines(osList).includes(release.value)}
                      onChange={(e) => {
                        const current = lines(osList);
                        setOsList(
                          (e.target.checked
                            ? [...current, release.value]
                            : current.filter((entry) => entry !== release.value)
                          ).join(", "),
                        );
                      }}
                    />
                    {release.label}
                  </label>
                ))}
              </div>
              <small>None ticked means every operating system.</small>
            </div>
            <Field label="Host name pattern" hint="Shell-style wildcards, e.g. ws-*">
              <input value={hostname} onChange={(e) => setHostname(e.target.value)} />
            </Field>
            <Field label="IP ranges" hint="Comma separated CIDR, e.g. 10.10.0.0/16">
              <input value={ipRanges} onChange={(e) => setIpRanges(e.target.value)} />
            </Field>
            <div className="field">
              <span>Groups</span>
              <ChoiceList
                kind="group"
                values={lines(groups)}
                onChange={(next) => setGroups(next.join("\n"))}
                addLabel="Add a group…"
                emptyLabel="Any group."
              />
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function LinksEditor({ gpo, onChanged }: { gpo: Gpo; onChanged: () => void }) {
  const [links, setLinks] = useState<GpoLink[]>(gpo.links ?? []);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      {/* A link only means something on an organizational unit or the domain
          head, so those are what the picker offers. The dropdown it replaces
          listed every container in the directory, CN=WMIPolicy included. */}
      <div className="page-header">
        <button type="button" className="primary" onClick={() => setPicking(true)}>
          <Plus size={15} aria-hidden="true" />
          Link here…
        </button>
      </div>

      {picking && (
        <ContainerPicker
          title={`Link ${gpo.display_name} to`}
          submitLabel="Link here"
          onlyOrganizationalUnits
          onClose={() => setPicking(false)}
          onPick={(dn) => {
            setPicking(false);
            void run(() => api.policy.link(gpo.guid, dn));
          }}
        />
      )}

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
        Link order 1 has the highest precedence at a container. Enforced links override anything set
        closer to the object and survive blocked inheritance.
      </p>
    </div>
  );
}

/** Hands the browser a file without a round trip through the server. */
function download(filename: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Bringing exported policy objects in.
 *
 * Links are left alone by default. The containers an export names belong to
 * the domain it came from, and an import that silently changed what applies
 * to whom would be the worst possible surprise from a button labelled
 * Import.
 */
function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [conflict, setConflict] = useState<"skip" | "replace" | "rename">("skip");
  const [restoreLinks, setRestoreLinks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.policy.import>> | null>(null);

  return (
    <Modal
      title="Import group policy objects"
      submitLabel={result ? "Close" : "Import"}
      busy={busy}
      error={error}
      wide
      onClose={onClose}
      onSubmit={async () => {
        if (result) {
          onDone();
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const parsed = JSON.parse(text);
          setResult(
            await api.policy.import({
              format: parsed.format,
              objects: parsed.objects ?? [],
              on_conflict: conflict,
              restore_links: restoreLinks,
            }),
          );
        } catch (err) {
          setError(
            err instanceof ApiError
              ? err.message
              : err instanceof SyntaxError
                ? "that is not a policy export: the file is not valid JSON"
                : String(err),
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      {result ? (
        <>
          <p>
            {result.created.length} created, {result.replaced.length} replaced,{" "}
            {result.skipped.length} skipped.
          </p>
          {result.skipped.length > 0 && (
            <table className="data compact">
              <thead>
                <tr>
                  <th scope="col">Skipped</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {result.skipped.map((entry) => (
                  <tr key={entry.name}>
                    <td>{entry.name}</td>
                    <td className="muted">{entry.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.links_skipped.length > 0 && (
            <p className="muted">
              {result.links_skipped.length} link(s) were not restored because the container they
              name does not exist here.
            </p>
          )}
        </>
      ) : (
        <>
          <Field label="Export file" hint="Choose the .json an export produced">
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void file.text().then(setText);
              }}
            />
          </Field>

          <Field label="If a name already exists">
            <select
              value={conflict}
              onChange={(e) => setConflict(e.target.value as typeof conflict)}
            >
              <option value="skip">Leave the existing one alone</option>
              <option value="replace">Replace it with the imported one</option>
              <option value="rename">Bring the imported one in beside it</option>
            </select>
          </Field>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={restoreLinks}
              onChange={(e) => setRestoreLinks(e.target.checked)}
            />
            Also link them where the export was linked
          </label>
          <p className="muted">
            Off by default. Links name containers from the domain the export came from, and only
            those that exist here could be restored anyway.
          </p>
        </>
      )}
    </Modal>
  );
}
