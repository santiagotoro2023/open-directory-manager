import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, FolderPlus, Home } from "lucide-react";
import { ApiError, api, type DirectoryListing } from "../api";
import { Field, Modal } from "./Modal";

/* Choosing where a share lives used to mean typing a path and finding out
   whether it existed when the share failed to come up. The agent answers a
   listing in about a second, so the server can be browsed instead. */

export function DirectoryField({
  node,
  value,
  onChange,
  placeholder,
  required,
}: {
  node: string;
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="picker-field">
        <input
          value={value}
          required={required}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="ghost" disabled={!node} onClick={() => setOpen(true)}>
          Browse…
        </button>
      </div>
      {open && (
        <DirectoryPicker
          node={node}
          start={value}
          onClose={() => setOpen(false)}
          onChoose={(path) => {
            onChange(path);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function DirectoryPicker({
  node,
  start,
  onClose,
  onChoose,
}: {
  node: string;
  start: string;
  onClose: () => void;
  onChoose: (path: string) => void;
}) {
  const [path, setPath] = useState(start.startsWith("/") ? start : "/");
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState("");

  const load = useCallback(
    async (target: string, make = false) => {
      setBusy(true);
      setError(null);
      try {
        const result = await api.servers.browse(node, target, make);
        setListing(result);
        setPath(result.path);
      } catch (err) {
        // A path that has gone away should not leave the dialog empty.
        setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [node],
  );

  useEffect(() => {
    void load(start.startsWith("/") ? start : "/");
    // Deliberately once: afterwards the dialog navigates itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const crumbs = path === "/" ? [] : path.split("/").filter(Boolean);

  return (
    <Modal
      title={`Choose a folder on ${node}`}
      submitLabel="Use this folder"
      busy={busy}
      error={error}
      wide
      onClose={onClose}
      onSubmit={() => onChoose(path)}
    >
      <nav className="path-crumbs" aria-label="Path">
        <button type="button" className="icon" aria-label="Root" onClick={() => void load("/")}>
          <Home size={15} aria-hidden="true" />
        </button>
        {crumbs.map((part, index) => (
          <span key={index}>
            <ChevronRight size={14} aria-hidden="true" />
            <button
              type="button"
              onClick={() => void load("/" + crumbs.slice(0, index + 1).join("/"))}
            >
              {part}
            </button>
          </span>
        ))}
      </nav>

      <ul className="picker-results">
        {listing?.parent && (
          <li>
            <button type="button" onClick={() => void load(listing.parent!)}>
              <Folder size={15} aria-hidden="true" />
              <span>..</span>
            </button>
          </li>
        )}
        {listing?.entries.map((entry) => (
          <li key={entry.path}>
            <button type="button" onClick={() => void load(entry.path)}>
              <Folder size={15} aria-hidden="true" />
              <span>{entry.name}</span>
            </button>
          </li>
        ))}
        {listing && listing.entries.length === 0 && (
          <li className="empty">No folders here. Use this one, or make a new one below.</li>
        )}
      </ul>
      {listing?.truncated && <p className="muted">Only the first 500 folders are listed.</p>}

      <Field label="New folder here">
        <div className="picker-field">
          <input
            value={creating}
            placeholder="shared"
            onChange={(e) => setCreating(e.target.value)}
          />
          <button
            type="button"
            className="ghost"
            disabled={!creating.trim() || busy}
            onClick={async () => {
              const name = creating.trim();
              setCreating("");
              await load(`${path === "/" ? "" : path}/${name}`, true);
            }}
          >
            <FolderPlus size={15} aria-hidden="true" />
            Create
          </button>
        </div>
      </Field>

      <p className="muted mono">{path}</p>
    </Modal>
  );
}
