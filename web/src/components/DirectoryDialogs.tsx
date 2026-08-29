import { useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { ApiError, api, type DirectoryObject, type Gpo } from "../api";
import { Field, Modal } from "./Modal";

function parentOf(dn: string): string {
  const comma = dn.indexOf(",");
  return comma === -1 ? "" : dn.slice(comma + 1);
}

function currentName(object: DirectoryObject): string {
  return String(object.ou ?? object.cn ?? object.name ?? "");
}

/**
 * Rename in place.
 *
 * A rename in a directory is a move whose destination is the container the
 * object is already in, which is why it goes through the same endpoint.
 */
export function RenameDialog({
  object,
  onClose,
  onRenamed,
}: {
  object: DirectoryObject;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(currentName(object));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={`Rename ${currentName(object)}`}
      submitLabel="Rename"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.directory.move(
            object.distinguishedName,
            parentOf(object.distinguishedName),
            name.trim(),
          );
          onRenamed();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name">
        <input value={name} required autoFocus onChange={(e) => setName(e.target.value)} />
      </Field>
      <p className="muted">
        The account name and the group memberships are unaffected; only the object&rsquo;s place
        in the tree changes.
      </p>
    </Modal>
  );
}

/** Link an existing policy object to this container, the way GPMC does it. */
export function LinkPolicyDialog({
  targetDn,
  onClose,
  onLinked,
}: {
  targetDn: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [gpos, setGpos] = useState<Gpo[]>([]);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.policy
      .list()
      .then((result) => {
        setGpos(result.gpos);
        setChosen((current) => current || result.gpos[0]?.guid || "");
      })
      .catch((err) => setError(String(err)));
  }, []);

  return (
    <Modal
      title="Link a policy object"
      submitLabel="Link here"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        if (!chosen) return;
        setBusy(true);
        setError(null);
        try {
          await api.policy.link(chosen, targetDn);
          onLinked();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="mono muted">{targetDn}</p>
      <ul className="picker-results">
        {gpos.map((gpo) => (
          <li key={gpo.guid}>
            <button
              type="button"
              className={chosen === gpo.guid ? "active" : ""}
              onClick={() => setChosen(gpo.guid)}
            >
              <ClipboardList size={15} aria-hidden="true" />
              {gpo.display_name}
              <span className="secondary">{gpo.enabled ? "" : "disabled"}</span>
            </button>
          </li>
        ))}
        {gpos.length === 0 && <li className="empty">No policy objects to link yet.</li>}
      </ul>
    </Modal>
  );
}
