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
import { useContextMenu, type MenuItem } from "../components/ContextMenu";
import { EnrolmentTokens } from "../components/EnrolmentTokens";
import { LinkPolicyDialog, RenameDialog } from "../components/DirectoryDialogs";
import { isDisabled } from "../components/objectDialogs";
import { Split } from "../components/Split";
import { useNavigate } from "react-router-dom";

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
  computer: "Computer",
  ou: "Organizational unit",
  container: "Container",
  domain: "Domain",
};

// Containers the directory keeps for its own bookkeeping. Nothing an operator
// manages lives in them, so they are out of the way until asked for.
const PLUMBING = new Set([
  "keys",
  "foreignsecurityprincipals",
  "managed service accounts",
  "program data",
  "system",
  "ntds quotas",
  "infrastructure",
  "lostandfound",
  "tpm devices",
  "deleted objects",
]);

function parentOf(dn: string): string {
  const comma = dn.indexOf(",");
  return comma === -1 ? "" : dn.slice(comma + 1);
}

function label(node: DirectoryObject): string {
  return String(node.ou ?? node.cn ?? node.name ?? node.distinguishedName);
}

function isPlumbing(node: DirectoryObject): boolean {
  return PLUMBING.has(label(node).toLowerCase());
}

export function Directory() {
  const [nodes, setNodes] = useState<DirectoryObject[]>([]);
  const [baseDn, setBaseDn] = useState("");
  const [domainLabel, setDomainLabel] = useState("");
  const [container, setContainer] = useState("");
  const [objects, setObjects] = useState<DirectoryObject[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [typeFilter, setTypeFilter] = useState<ObjectType | "">("");
  const [search, setSearch] = useState("");
  const [showPlumbing, setShowPlumbing] = useState(false);
  const [creating, setCreating] = useState<ObjectType | null>(null);
  const [importing, setImporting] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState<string | null>(null);
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState<DirectoryObject | null>(null);
  const { bind, menu } = useContextMenu();

  const loadTree = useCallback(async () => {
    const tree = await api.directory.tree();
    setBaseDn(tree.base_dn);
    // The domain answers to its short name everywhere else — on a client's
    // login screen, in a sudo rule, in a group name — so that is what the root
    // of the tree is called here too.
    setDomainLabel(tree.netbios_name || tree.domain || tree.base_dn);
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

  const open = useCallback(
    (node: DirectoryObject) =>
      navigate(`/directory/object?dn=${encodeURIComponent(node.distinguishedName)}`),
    [navigate],
  );

  const refresh = useCallback(async () => {
    await loadTree();
    await loadObjects();
  }, [loadTree, loadObjects]);

  const visible = useMemo(
    () => (showPlumbing ? nodes : nodes.filter((node) => !isPlumbing(node))),
    [nodes, showPlumbing],
  );

  function containerMenu(node: DirectoryObject): MenuItem[] {
    const dn = node.distinguishedName;
    const isOu = node.objectType === "ou";
    return [
      { label: label(node), heading: true },
      { label: "New user", onSelect: () => { setContainer(dn); setCreating("user"); } },
      { label: "New group", onSelect: () => { setContainer(dn); setCreating("group"); } },
      { label: "New computer", onSelect: () => { setContainer(dn); setCreating("computer"); } },
      {
        label: "New organizational unit",
        onSelect: () => { setContainer(dn); setCreating("ou"); },
      },
      { separator: true },
      { label: "Link a policy object…", onSelect: () => setLinking(dn) },
      { separator: true },
      { label: "Rename", disabled: !isOu, onSelect: () => setRenaming(node) },
      {
        label: "Delete",
        danger: true,
        disabled: !isOu,
        onSelect: () => open(node),
      },
    ];
  }

  const tree = (
    <>
      <nav className="tree" aria-label="Organizational units">
        <TreeNode
          nodes={visible}
          dn={baseDn}
          rootLabel={domainLabel}
          selected={container}
          menuFor={containerMenu}
          bind={bind}
          onSelect={(dn) => {
            setSearch("");
            setContainer(dn);
          }}
        />
      </nav>
      <div className="pane-footer">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={showPlumbing}
            onChange={(e) => setShowPlumbing(e.target.checked)}
          />
          Show system containers
        </label>
      </div>
    </>
  );

  return (
    <Split
      id="directory"
      label="Resize the directory tree"
      initial={260}
      side={tree}
    >
      <section className="objects">
        <div className="page-header">
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
            <option value="computer">Computers</option>
            <option value="ou">Organizational units</option>
          </select>
          <span className="spacer" />
          <select
            aria-label="Create an object"
            value=""
            onChange={(e) => e.target.value && setCreating(e.target.value as ObjectType)}
          >
            <option value="">Create…</option>
            <option value="user">User</option>
            <option value="group">Group</option>
            <option value="computer">Computer</option>
            <option value="ou">Organizational unit</option>
          </select>
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
                  onClick={() => open(object)}
                  onDoubleClick={() =>
                    object.objectType === "ou" && setContainer(object.distinguishedName)
                  }
                  {...bind([
                    { label: label(object), heading: true },
                    { label: "Open", onSelect: () => open(object) },
                    {
                      label: "Show contents",
                      disabled: object.objectType !== "ou",
                      onSelect: () => setContainer(object.distinguishedName),
                    },
                    { separator: true },
                    { label: "Rename", onSelect: () => setRenaming(object) },
                    {
                      label: "Link a policy object…",
                      disabled: object.objectType !== "ou",
                      onSelect: () => setLinking(object.distinguishedName),
                    },
                    { separator: true },
                    { label: "Delete", danger: true, onSelect: () => open(object) },
                  ])}
                >
                  <td>
                    <Icon size={15} aria-hidden="true" />
                    {label(object)}
                    {isDisabled(object) && <span className="badge">Disabled</span>}
                  </td>
                  <td>
                    {object.objectType === "group"
                      ? object.groupKind === "computer"
                        ? "Computer group"
                        : "User group"
                      : (TYPE_LABELS[object.objectType] ?? object.objectType)}
                  </td>
                  <td>{String(object.sAMAccountName ?? "")}</td>
                  <td>{String(object.description ?? "")}</td>
                </tr>
              );
            })}
            {!loading && objects.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  Nothing here yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {truncated && <p className="muted">Results truncated — narrow the search.</p>}
      </section>

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

      {menu}

      {linking && (
        <LinkPolicyDialog
          targetDn={linking}
          onClose={() => setLinking(null)}
          onLinked={() => setLinking(null)}
        />
      )}

      {renaming && (
        <RenameDialog
          object={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            void refresh();
          }}
        />
      )}

      {importing && (
        <BulkImport
          container={container}
          onClose={() => setImporting(false)}
          onImported={() => void refresh()}
        />
      )}
    </Split>
  );
}

function TreeNode({
  nodes,
  dn,
  rootLabel,
  selected,
  menuFor,
  bind,
  onSelect,
}: {
  nodes: DirectoryObject[];
  dn: string;
  rootLabel?: string;
  selected: string;
  menuFor: (node: DirectoryObject) => MenuItem[];
  bind: (items: MenuItem[]) => { onContextMenu: (event: React.MouseEvent) => void };
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
  const name = rootLabel ?? label(self);

  return (
    <div className="tree-node">
      <div
        className={selected === dn ? "tree-row active" : "tree-row"}
        {...bind(menuFor(self))}
      >
        <button
          type="button"
          className="icon"
          aria-label={open ? `Collapse ${name}` : `Expand ${name}`}
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
          <span className="truncate">{name}</span>
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
              menuFor={menuFor}
              bind={bind}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
