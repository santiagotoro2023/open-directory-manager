import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Monitor,
  Search,
  Upload,
  User,
  Users,
} from "lucide-react";
import { ApiError, api, type DirectoryObject, type ObjectType } from "../api";
import { BulkImport, CreateDialog } from "../components/CreateDialog";
import { EnrolmentTokens } from "../components/EnrolmentTokens";
import { ObjectPanel, isDisabled } from "../components/ObjectPanel";

const ICONS = {
  user: User,
  group: Users,
  computer: Monitor,
  ou: Folder,
  container: Folder,
  domain: Folder,
} as const;

const TYPE_LABELS: Record<string, string> = {
  user: "User",
  group: "Group",
  computer: "Host",
  ou: "Organizational unit",
  container: "Container",
  domain: "Domain",
};

function parentOf(dn: string): string {
  const comma = dn.indexOf(",");
  return comma === -1 ? "" : dn.slice(comma + 1);
}

function label(node: DirectoryObject): string {
  return String(node.ou ?? node.cn ?? node.name ?? node.distinguishedName);
}

export function Directory() {
  const [nodes, setNodes] = useState<DirectoryObject[]>([]);
  const [baseDn, setBaseDn] = useState("");
  const [container, setContainer] = useState("");
  const [objects, setObjects] = useState<DirectoryObject[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [typeFilter, setTypeFilter] = useState<ObjectType | "">("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DirectoryObject | null>(null);
  const [creating, setCreating] = useState<ObjectType | null>(null);
  const [importing, setImporting] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadTree = useCallback(async () => {
    const tree = await api.directory.tree();
    setBaseDn(tree.base_dn);
    setNodes(tree.nodes);
    setContainer((current) => current || tree.base_dn);
  }, []);

  const loadObjects = useCallback(async () => {
    if (!container) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.directory.list({
        container: search ? baseDn : container,
        object_type: typeFilter || undefined,
        query: search || undefined,
        scope: search ? "subtree" : "level",
      });
      setObjects(result.objects);
      setTruncated(result.truncated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setObjects([]);
    } finally {
      setLoading(false);
    }
  }, [container, typeFilter, search, baseDn]);

  useEffect(() => {
    loadTree().catch((err) => setError(String(err)));
  }, [loadTree]);

  useEffect(() => {
    const timer = setTimeout(() => void loadObjects(), search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [loadObjects, search]);

  const refresh = useCallback(async () => {
    await loadTree();
    await loadObjects();
  }, [loadTree, loadObjects]);

  const containers = useMemo(
    () => nodes.filter((n) => n.objectType !== "domain" || n.distinguishedName === baseDn),
    [nodes, baseDn],
  );

  return (
    <div className="directory">
      <nav className="tree" aria-label="Organizational units">
        <TreeNode
          nodes={nodes}
          dn={baseDn}
          selected={container}
          onSelect={(dn) => {
            setSearch("");
            setContainer(dn);
            setSelected(null);
          }}
        />
      </nav>

      <section className="objects">
        <div className="toolbar">
          <div className="search">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label="Search the directory"
              placeholder="Search the whole domain"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            aria-label="Filter by object type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as ObjectType | "")}
          >
            <option value="">All types</option>
            <option value="user">Users</option>
            <option value="group">Groups</option>
            <option value="computer">Hosts</option>
            <option value="ou">Organizational units</option>
          </select>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={() => setCreating("user")}>
            New user
          </button>
          <button type="button" className="ghost" onClick={() => setCreating("group")}>
            New group
          </button>
          <button type="button" className="ghost" onClick={() => setCreating("computer")}>
            New host
          </button>
          <button type="button" className="ghost" onClick={() => setCreating("ou")}>
            New OU
          </button>
          <button type="button" className="ghost" onClick={() => setImporting(true)}>
            <Upload size={15} aria-hidden="true" />
            Import CSV
          </button>
          <button type="button" className="ghost" onClick={() => setEnrolling(true)}>
            Enrolment tokens
          </button>
        </div>

        <p className="mono muted breadcrumb">{search ? `Search: ${search}` : container}</p>

        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}

        <table className="data">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Account name</th>
              <th scope="col">Description</th>
            </tr>
          </thead>
          <tbody>
            {objects.map((object) => {
              const Icon = ICONS[object.objectType as keyof typeof ICONS] ?? Folder;
              return (
                <tr
                  key={object.distinguishedName}
                  className={
                    selected?.distinguishedName === object.distinguishedName ? "selected" : ""
                  }
                  onClick={() => setSelected(object)}
                  onDoubleClick={() =>
                    object.objectType === "ou" && setContainer(object.distinguishedName)
                  }
                >
                  <td>
                    <Icon size={15} aria-hidden="true" />
                    {label(object)}
                    {isDisabled(object) && <span className="badge">Disabled</span>}
                  </td>
                  <td>{TYPE_LABELS[object.objectType] ?? object.objectType}</td>
                  <td>{String(object.sAMAccountName ?? "")}</td>
                  <td>{String(object.description ?? "")}</td>
                </tr>
              );
            })}
            {!loading && objects.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No objects here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {truncated && <p className="muted">Results truncated — narrow the search.</p>}
      </section>

      {selected && (
        <ObjectPanel
          object={selected}
          containers={containers}
          onClose={() => setSelected(null)}
          onChanged={(updated) => {
            setSelected(updated);
            void refresh();
          }}
          onDeleted={() => {
            setSelected(null);
            void refresh();
          }}
        />
      )}

      {creating && (
        <CreateDialog
          type={creating}
          container={container}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null);
            void refresh();
          }}
        />
      )}

      {enrolling && (
        <EnrolmentTokens container={container} onClose={() => setEnrolling(false)} />
      )}

      {importing && (
        <BulkImport
          container={container}
          onClose={() => setImporting(false)}
          onImported={() => void refresh()}
        />
      )}
    </div>
  );
}

function TreeNode({
  nodes,
  dn,
  selected,
  onSelect,
}: {
  nodes: DirectoryObject[];
  dn: string;
  selected: string;
  onSelect: (dn: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const self = nodes.find((n) => n.distinguishedName === dn);
  // ponytail: O(n) scan per node. Directory trees are tens to hundreds of
  // containers; build a parent index here if that stops being true.
  const children = nodes.filter(
    (n) => parentOf(n.distinguishedName).toLowerCase() === dn.toLowerCase(),
  );
  if (!self) return null;

  return (
    <div className="tree-node">
      <div className={selected === dn ? "tree-row active" : "tree-row"}>
        <button
          type="button"
          className="icon"
          aria-label={open ? `Collapse ${label(self)}` : `Expand ${label(self)}`}
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
          {label(self)}
        </button>
      </div>
      {open && children.length > 0 && (
        <div className="tree-children">
          {children.map((child) => (
            <TreeNode
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
