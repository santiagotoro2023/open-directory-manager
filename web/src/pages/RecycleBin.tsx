import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Search, Trash2 } from "lucide-react";
import { ApiError, api, type DeletedObject } from "../api";
import { Field, Modal } from "../components/Modal";
import { PickerField } from "../components/Picker";

export function RecycleBin() {
  const [items, setItems] = useState<DeletedObject[]>([]);
  const [retention, setRetention] = useState(180);
  const [query, setQuery] = useState("");
  const [includeRestored, setIncludeRestored] = useState(false);
  const [confirming, setConfirming] = useState<{ item: DeletedObject; purge: boolean } | null>(
    null,
  );
  const [container, setContainer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.recyclebin.list({ query, include_restored: includeRestored });
      setItems(result.items);
      setRetention(result.retention_days);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [query, includeRestored]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);

  async function act(item: DeletedObject, purge: boolean) {
    setError(null);
    setNotice(null);
    try {
      if (purge) {
        await api.recyclebin.purge(item.id);
        setNotice(`Purged ${item.object_dn}.`);
      } else {
        await api.recyclebin.restore(item.id, container || undefined);
        setNotice(
          `Restored ${item.object_dn}. It has a new SID, so re-grant any access that named the old one; accounts come back disabled.`,
        );
      }
      setConfirming(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <main className="content">
      <h1>Deleted Objects</h1>
      <p className="muted">
        Everything deleted through ODM is snapshotted before the directory delete and kept for{" "}
        {retention} days, then purged automatically.
      </p>

      <div className="toolbar">
        <div className="search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Search deleted objects"
            placeholder="Search by name or distinguished name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includeRestored}
            onChange={(e) => setIncludeRestored(e.target.checked)}
          />
          Show already restored
        </label>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}

      <table className="data">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">Deleted</th>
            <th scope="col">By</th>
            <th scope="col">Purged after</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <strong>{item.display_name || item.object_dn}</strong>
                <p className="mono muted">{item.object_dn}</p>
              </td>
              <td>{item.object_type}</td>
              <td>{new Date(item.deleted_at).toLocaleString()}</td>
              <td>{item.deleted_by}</td>
              <td>
                {item.restored_at ? (
                  <span className="badge success">restored</span>
                ) : (
                  new Date(item.purge_after).toLocaleDateString()
                )}
              </td>
              <td>
                {!item.restored_at && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setContainer(item.parent_dn);
                      setConfirming({ item, purge: false });
                    }}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    Restore
                  </button>
                )}
                <button
                  type="button"
                  className="icon"
                  aria-label={`Purge ${item.object_dn}`}
                  onClick={() => setConfirming({ item, purge: true })}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                Nothing in the recycle bin.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {confirming && (
        <Modal
          title={confirming.purge ? "Purge permanently" : "Restore object"}
          submitLabel={confirming.purge ? "Purge" : "Restore"}
          onClose={() => setConfirming(null)}
          onSubmit={() => void act(confirming.item, confirming.purge)}
        >
          <p className="mono">{confirming.item.object_dn}</p>
          {confirming.purge ? (
            <p className="muted">
              The snapshot is destroyed and the object can never be restored. This does not wait for
              the retention window.
            </p>
          ) : (
            <>
              <p className="muted">
                Recreated with its attributes, and rejoined to{" "}
                {confirming.item.memberships.length} group(s).
              </p>
              <Field
                label="Restore into"
                hint="Where it came from. Change it if that container is gone."
              >
                <PickerField
                  kind="ou"
                  as="dn"
                  ariaLabel="Restore into"
                  value={container}
                  onChange={setContainer}
                />
              </Field>
              <p className="muted">
                The directory issues a new SID and GUID, so access rules that named the old SID need
                re-granting. Accounts come back disabled and need a password set.
              </p>
            </>
          )}
        </Modal>
      )}
    </main>
  );
}
