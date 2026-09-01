import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { ApiError, api, type FileShare, type ShareAccess, type ShareEntry } from "../api";
import { useContextMenu } from "../components/ContextMenu";
import { Field, Modal } from "../components/Modal";
import { PickerField } from "../components/Picker";
import { DirectoryField } from "../components/DirectoryPicker";
import Select from "../components/Select"

const ACCESS: { value: ShareAccess; label: string }[] = [
  { value: "read", label: "Read" },
  { value: "change", label: "Read & write" },
  { value: "full", label: "Full control" },
];

const STATE_BADGE: Record<string, string> = {
  active: "success",
  failed: "failure",
  applying: "",
  pending: "",
};

export function Shares() {
  const [shares, setShares] = useState<FileShare[]>([]);
  const [open, setOpen] = useState<FileShare | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<FileShare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { bind, menu } = useContextMenu();

  const load = useCallback(async () => {
    setError(null);
    try {
      setShares((await api.shares.list()).shares);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A share is made real by the server's agent on its next check-in, so the
  // state moves without anything on this page having caused it.
  useEffect(() => {
    if (!shares.some((share) => share.state === "applying")) return;
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, [shares, load]);

  return (
    <main className="content">
      <div className="page-header">
        <h1>File Shares</h1>
        <span className="spacer" />
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          <Plus size={15} aria-hidden="true" />
          New share
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
            <th scope="col">Share</th>
            <th scope="col">Server</th>
            <th scope="col">Directory</th>
            <th scope="col">Access</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {shares.map((share) => (
            <tr
              key={share.id}
              onClick={() => setOpen(share)}
              {...bind([
                { label: share.name, heading: true },
                { label: "Permissions…", onSelect: () => setOpen(share) },
                { separator: true },
                {
                  label: "Stop sharing",
                  danger: true,
                  onSelect: () => setRemoving(share),
                },
              ])}
            >
              <td>
                <FolderOpen size={15} aria-hidden="true" />
                {share.name}
                {share.read_only && <span className="badge">read only</span>}
              </td>
              <td className="mono">{share.node_fqdn}</td>
              <td className="mono">{share.path}</td>
              <td>
                {share.entries.length === 0 ? "Nobody yet" : `${share.entries.length} entries`}
              </td>
              <td>
                <span className={`badge ${STATE_BADGE[share.state] ?? ""}`}>{share.state}</span>
                {share.last_error && <p className="muted">{share.last_error}</p>}
              </td>
            </tr>
          ))}
          {shares.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                No shares yet. A server needs the file-server role before it can carry one.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {menu}

      {creating && (
        <ShareDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      {open && (
        <ShareDialog
          share={open}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            void load();
          }}
        />
      )}

      {removing && (
        <Modal
          title={`Stop sharing ${removing.name}?`}
          submitLabel="Stop sharing"
          onClose={() => setRemoving(null)}
          onSubmit={async () => {
            await api.shares.remove(removing.id).catch(() => undefined);
            setRemoving(null);
            void load();
          }}
        >
          <p>
            {removing.unc} stops being reachable. The directory {removing.path} and everything in it
            stays on {removing.node_fqdn}.
          </p>
        </Modal>
      )}
    </main>
  );
}

function ShareDialog({
  share,
  onClose,
  onSaved,
}: {
  share?: FileShare;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = share !== undefined;
  const [node, setNode] = useState(share?.node_fqdn ?? "");
  const [name, setName] = useState(share?.name ?? "");
  const [path, setPath] = useState(share?.path ?? "");
  const [comment, setComment] = useState(share?.comment ?? "");
  const [owner, setOwner] = useState(share?.owner ?? "root");
  const [ownerGroup, setOwnerGroup] = useState(share?.owner_group ?? "Domain Admins");
  const [entries, setEntries] = useState<ShareEntry[]>(share?.entries ?? []);
  const [readOnly, setReadOnly] = useState(share?.read_only ?? false);
  const [browseable, setBrowseable] = useState(share?.browseable ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(index: number, changes: Partial<ShareEntry>) {
    setEntries(entries.map((entry, i) => (i === index ? { ...entry, ...changes } : entry)));
  }

  return (
    <Modal
      title={editing ? share.name : "New file share"}
      submitLabel={editing ? "Save" : "Create"}
      busy={busy}
      error={error}
      wide
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          if (editing) {
            await api.shares.update({
              id: share.id,
              comment,
              owner,
              owner_group: ownerGroup,
              entries,
              browseable,
              read_only: readOnly,
            });
          } else {
            await api.shares.create({
              node_fqdn: node,
              name,
              path,
              comment,
              owner,
              owner_group: ownerGroup,
              entries,
              browseable,
              read_only: readOnly,
            });
          }
          onSaved();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {editing ? (
        <p className="mono muted">{share.unc}</p>
      ) : (
        <>
          <Field label="Server" hint="A machine carrying the file-server role">
            <PickerField
              kind="computer"
              as="host"
              ariaLabel="Server"
              value={node}
              required
              placeholder="fs01.corp.example.internal"
              onChange={setNode}
            />
          </Field>
          <Field label="Share name" hint="What clients see, as //server/name">
            <input value={name} required onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="Directory on the server"
            hint="Browse the server for it, or type a path that will be created"
          >
            <DirectoryField
              node={node}
              value={path}
              required
              placeholder="/srv/shares/shared"
              onChange={setPath}
            />
          </Field>
        </>
      )}

      <Field label="Description">
        <input value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>

      <div className="inline-fields">
        <Field label="Owner">
          <PickerField kind="user" ariaLabel="Owner" value={owner} onChange={setOwner} />
        </Field>
        <Field label="Owning group">
          <PickerField
            kind="group"
            ariaLabel="Owning group"
            value={ownerGroup}
            onChange={setOwnerGroup}
          />
        </Field>
      </div>

      <label className="checkbox">
        <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
        Read only for everyone
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={browseable}
          onChange={(e) => setBrowseable(e.target.checked)}
        />
        Visible when browsing the server
      </label>

      <h3 className="section-title">Permissions</h3>
      <table className="data compact">
        <thead>
          <tr>
            <th scope="col">Who</th>
            <th scope="col" style={{ width: "120px" }}>
              Type
            </th>
            <th scope="col" style={{ width: "160px" }}>
              Access
            </th>
            <th scope="col" style={{ width: "150px" }}>
              Applies to new files
            </th>
            <th style={{ width: "44px" }}>
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={index}>
              <td>
                <PickerField
                  kind={entry.kind}
                  ariaLabel="Who"
                  value={entry.principal}
                  onChange={(principal) => update(index, { principal })}
                />
              </td>
              <td>
                <Select
                  aria-label="Type"
                  value={entry.kind}
                  onChange={(e) => update(index, { kind: e.target.value as "user" | "group" })}
                >
                  <option value="group">Group</option>
                  <option value="user">User</option>
                </Select>
              </td>
              <td>
                <Select
                  aria-label="Access"
                  value={entry.access}
                  onChange={(e) => update(index, { access: e.target.value as ShareAccess })}
                >
                  {ACCESS.map((level) => (
                    <option key={level.value} value={level.value}>
                      {level.label}
                    </option>
                  ))}
                </Select>
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label="Applies to new files"
                  checked={entry.inherit}
                  onChange={(e) => update(index, { inherit: e.target.checked })}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Remove ${entry.principal || "entry"}`}
                  onClick={() => setEntries(entries.filter((_, i) => i !== index))}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                Nobody but the owner and the owning group can reach this share.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="actions-row">
        <button
          type="button"
          className="ghost"
          onClick={() =>
            setEntries([
              ...entries,
              { principal: "", kind: "group", access: "read", inherit: true },
            ])
          }
        >
          <Plus size={15} aria-hidden="true" />
          Add entry
        </button>
      </div>
    </Modal>
  );
}
