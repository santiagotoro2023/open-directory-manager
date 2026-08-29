import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Folder, Monitor, Search, User, Users } from "lucide-react";
import { ApiError, api, type DirectoryObject, type ObjectType } from "../api";
import { Modal } from "./Modal";

const ICONS = {
  user: User,
  group: Users,
  computer: Monitor,
  ou: Folder,
  container: Folder,
  domain: Folder,
} as const;

export type PickerKind = "user" | "group" | "computer" | "principal" | "ou";

const WANTED: Record<PickerKind, ObjectType[]> = {
  user: ["user"],
  group: ["group"],
  computer: ["computer"],
  principal: ["user", "group"],
  ou: ["ou"],
};

const TITLES: Record<PickerKind, string> = {
  user: "Select a user",
  group: "Select a group",
  computer: "Select a computer",
  principal: "Select a user or group",
  ou: "Select an organizational unit",
};

function name(object: DirectoryObject): string {
  return String(object.ou ?? object.cn ?? object.name ?? object.distinguishedName);
}

/** How a chosen object is written into the field that asked for it. */
export type PickerValue = "name" | "dn" | "principal" | "host";

function render(object: DirectoryObject, as: PickerValue): string {
  if (as === "dn") return object.distinguishedName;
  if (as === "host") return String(object.dNSHostName ?? name(object));
  const account = String(object.sAMAccountName ?? name(object));
  // Sudo and drive-map rules mark a group with a leading %, the way sudoers does.
  if (as === "principal" && object.objectType === "group") return `%${account}`;
  return account;
}

/**
 * A text field with the domain behind it.
 *
 * Anything the directory already knows is chosen rather than typed. The field
 * stays editable, because some values are legitimately not directory objects
 * (ALL, a literal path, a name that does not exist yet).
 */
export function PickerField({
  kind,
  as = "name",
  value,
  onChange,
  placeholder,
  required,
  multiple,
  ariaLabel,
}: {
  kind: PickerKind;
  as?: PickerValue;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  /** Append to a comma-separated list rather than replacing the value. */
  multiple?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="picker-field">
      <input
        aria-label={ariaLabel}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="button" className="ghost" onClick={() => setOpen(true)}>
        Select…
      </button>
      {open && (
        <PickerDialog
          kind={kind}
          onClose={() => setOpen(false)}
          onPick={(object) => {
            const picked = render(object, as);
            if (!multiple) onChange(picked);
            else {
              const existing = value
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean);
              if (!existing.includes(picked)) existing.push(picked);
              onChange(existing.join(", "));
            }
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

export function PickerDialog({
  kind,
  onClose,
  onPick,
}: {
  kind: PickerKind;
  onClose: () => void;
  onPick: (object: DirectoryObject) => void;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<ObjectType | "">(
    WANTED[kind].length === 1 ? WANTED[kind][0] : "",
  );
  const [results, setResults] = useState<DirectoryObject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const wanted = type ? [type] : WANTED[kind];
      const found = await Promise.all(
        wanted.map((objectType) =>
          api.directory.list({
            object_type: objectType,
            query: query || undefined,
            scope: "subtree",
            limit: 100,
          }),
        ),
      );
      setResults(found.flatMap((page) => page.objects));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [kind, type, query]);

  useEffect(() => {
    const timer = setTimeout(() => void search(), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [search, query]);

  return (
    <Modal title={TITLES[kind]} submitLabel="Close" onClose={onClose} onSubmit={onClose}>
      <div className="page-header">
        <div className="search">
          <Search size={15} aria-hidden="true" />
          <input
            autoFocus
            aria-label="Search the domain"
            placeholder="Type a name, or leave empty to list everything"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {WANTED[kind].length > 1 && (
          <select
            aria-label="Filter by type"
            value={type}
            onChange={(event) => setType(event.target.value as ObjectType | "")}
          >
            <option value="">All types</option>
            {WANTED[kind].map((option) => (
              <option key={option} value={option}>
                {option === "user" ? "Users" : option === "group" ? "Groups" : "Computers"}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <ul className="picker-results">
        {results.map((object) => {
          const Icon = ICONS[object.objectType as keyof typeof ICONS] ?? Folder;
          return (
            <li key={object.distinguishedName}>
              <button type="button" onClick={() => onPick(object)}>
                <Icon size={15} aria-hidden="true" />
                {name(object)}
                <span className="secondary">{String(object.sAMAccountName ?? "")}</span>
              </button>
            </li>
          );
        })}
        {!loading && results.length === 0 && <li className="empty">Nothing matched.</li>}
      </ul>
    </Modal>
  );
}

/**
 * Container picker: a tree rather than a search, because a container is chosen
 * by where it sits, not by its name.
 */
export function ContainerPicker({
  title,
  submitLabel,
  onlyOrganizationalUnits,
  onClose,
  onPick,
}: {
  title: string;
  submitLabel: string;
  onlyOrganizationalUnits?: boolean;
  onClose: () => void;
  onPick: (dn: string) => void;
}) {
  const [nodes, setNodes] = useState<DirectoryObject[]>([]);
  const [root, setRoot] = useState("");
  const [rootLabel, setRootLabel] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.directory
      .tree()
      .then((tree) => {
        setRoot(tree.base_dn);
        setRootLabel(tree.netbios_name || tree.domain || tree.base_dn);
        // Policy links only mean anything on organizational units and the
        // domain head; the rest of the tree is the directory's own bookkeeping.
        setNodes(
          onlyOrganizationalUnits
            ? tree.nodes.filter(
                (node) => node.objectType === "ou" || node.distinguishedName === tree.base_dn,
              )
            : tree.nodes,
        );
        setSelected(tree.base_dn);
      })
      .catch((err) => setError(String(err)));
  }, [onlyOrganizationalUnits]);

  return (
    <Modal
      title={title}
      submitLabel={submitLabel}
      onClose={onClose}
      onSubmit={() => selected && onPick(selected)}
    >
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="picker-tree">
        <Branch
          nodes={nodes}
          dn={root}
          label={rootLabel}
          selected={selected}
          onSelect={setSelected}
        />
      </div>
      <p className="mono muted">{selected}</p>
    </Modal>
  );
}

function Branch({
  nodes,
  dn,
  label,
  selected,
  onSelect,
}: {
  nodes: DirectoryObject[];
  dn: string;
  label?: string;
  selected: string;
  onSelect: (dn: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const self = nodes.find((node) => node.distinguishedName === dn);
  const children = nodes.filter((node) => {
    const comma = node.distinguishedName.indexOf(",");
    return comma !== -1 && node.distinguishedName.slice(comma + 1).toLowerCase() === dn.toLowerCase();
  });
  if (!self) return null;

  return (
    <div className="tree-node">
      <div className={selected === dn ? "tree-row active" : "tree-row"}>
        <button
          type="button"
          className="icon"
          aria-label={open ? "Collapse" : "Expand"}
          onClick={() => setOpen(!open)}
          style={{ visibility: children.length ? "visible" : "hidden" }}
        >
          {open ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
        </button>
        <button type="button" className="tree-label" onClick={() => onSelect(dn)}>
          <Folder size={14} aria-hidden="true" />
          <span className="truncate">{label ?? name(self)}</span>
        </button>
      </div>
      {open && children.length > 0 && (
        <div className="tree-children">
          {children.map((child) => (
            <Branch
              key={child.distinguishedName}
              nodes={nodes}
              dn={child.distinguishedName}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
