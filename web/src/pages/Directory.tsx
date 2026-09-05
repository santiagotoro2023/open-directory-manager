import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Field, Modal } from "../components/Modal";
import { PickerField } from "../components/Picker";
import { EnrolmentTokens } from "../components/EnrolmentTokens";
import { LinkPolicyDialog, RenameDialog } from "../components/DirectoryDialogs";
import { isDisabled } from "../components/objectDialogs";
import { Split } from "../components/Split";
import { useNavigate } from "react-router-dom";
import Select from "../components/Select"
import { InfoPanel } from "../components/DocsLink";
import { isSystemContainer, label, parentOf } from "../components/directoryTree";

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

// Organizational units the directory creates for itself. Together with the
// containers (Users, Computers, Builtin) these are the structure that was
// always there, as opposed to the structure an operator built.
const BUILTIN_OUS = new Set(["domain controllers"]);

// The MIME type an object's DN travels under while it's being dragged, so a
// drop target only reacts to a directory object and not, say, a file dragged
// in from the desktop.
const DN_MEDIA_TYPE = "application/x-odm-dn";

// Where in the tree the operator was. Session storage rather than local: it is
// navigation state, and a new browser session starts at the domain head.
const CONTAINER_KEY = "odm.directory.container";

function remembered(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    // Storage can be refused outright; the tree still works without it.
    return "";
  }
}

function remember(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* nothing to do: the position is not worth an error message */
  }
}

// A name match alone isn't identity: an operator can create their own
// "Domain Controllers" OU elsewhere in the tree, and it must not borrow the
// built-in one's look. Only the OU actually sitting where the directory put
// it — directly under the domain head — is the real one.
function isBuiltin(node: DirectoryObject, baseDn: string): boolean {
  if (node.objectType === "container" || node.objectType === "domain") return true;
  if (node.objectType !== "ou") return false;
  return (
    parentOf(node.distinguishedName).toLowerCase() === baseDn.toLowerCase() &&
    BUILTIN_OUS.has(label(node).toLowerCase())
  );
}


export function Directory() {
  const [nodes, setNodes] = useState<DirectoryObject[]>([]);
  const [baseDn, setBaseDn] = useState("");
  const [domainLabel, setDomainLabel] = useState("");
  // Where the tree was left. Opening an object unmounts this page, and coming
  // back put every operator at the top of the domain again — several clicks
  // below where they were working. Kept for the browser session, so it is the
  // same navigation state a Back button would have restored.
  const [container, setContainer] = useState(() => remembered(CONTAINER_KEY));
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
  // Objects picked for one change applied to all of them. Creating from CSV
  // has always been possible; changing what already exists has not, and doing
  // it one at a time is what makes a department move an afternoon's work.
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadTree = useCallback(async () => {
    const tree = await api.directory.tree();
    setBaseDn(tree.base_dn);
    // The domain answers to its short name everywhere else — on a client's
    // login screen, in a sudo rule, in a group name — so that is what the root
    // of the tree is called here too.
    setDomainLabel(tree.netbios_name || tree.domain || tree.base_dn);
    setNodes(tree.nodes);
    setContainer((current) => {
      // A remembered container that has since been deleted or renamed is not
      // somewhere to put anybody back.
      const known =
        current &&
        (current.toLowerCase() === tree.base_dn.toLowerCase() ||
          tree.nodes.some(
            (node) => node.distinguishedName.toLowerCase() === current.toLowerCase(),
          ));
      return known ? current : tree.base_dn;
    });
  }, []);

  useEffect(() => {
    if (container) remember(CONTAINER_KEY, container);
  }, [container]);

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

  const moveTo = useCallback(
    async (sourceDn: string, targetDn: string) => {
      if (
        sourceDn.toLowerCase() === targetDn.toLowerCase() ||
        parentOf(sourceDn).toLowerCase() === targetDn.toLowerCase()
      ) {
        return;
      }
      setError(null);
      try {
        await api.directory.move(sourceDn, targetDn);
        await refresh();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    },
    [refresh],
  );

  const visible = useMemo(
    () => (showPlumbing ? nodes : nodes.filter((node) => !isSystemContainer(node))),
    [nodes, showPlumbing],
  );

  function containerMenu(node: DirectoryObject): MenuItem[] {
    const dn = node.distinguishedName;
    const isOu = node.objectType === "ou";
    return [
      { label: label(node), heading: true },
      {
        label: "New user",
        onSelect: () => {
          setContainer(dn);
          setCreating("user");
        },
      },
      {
        label: "New group",
        onSelect: () => {
          setContainer(dn);
          setCreating("group");
        },
      },
      {
        label: "New computer",
        onSelect: () => {
          setContainer(dn);
          setCreating("computer");
        },
      },
      {
        label: "New organizational unit",
        onSelect: () => {
          setContainer(dn);
          setCreating("ou");
        },
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
          baseDn={baseDn}
          rootLabel={domainLabel}
          selected={container}
          menuFor={containerMenu}
          bind={bind}
          onSelect={(dn) => {
            setSearch("");
            setContainer(dn);
          }}
          onMove={moveTo}
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
    <Split id="directory" label="Resize the directory tree" initial={260} side={tree}>
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
          <Select
            aria-label="Filter by object type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as ObjectType | "")}
          >
            <option value="">All types</option>
            <option value="user">Users</option>
            <option value="group">Groups</option>
            <option value="computer">Computers</option>
            <option value="ou">Organizational units</option>
          </Select>
          <span className="spacer" />
          <Select
            aria-label="Create an object"
            value=""
            onChange={(e) => e.target.value && setCreating(e.target.value as ObjectType)}
          >
            <option value="">Create…</option>
            <option value="user">User</option>
            <option value="group">Group</option>
            <option value="computer">Computer</option>
            <option value="ou">Organizational unit</option>
          </Select>
          <button type="button" className="ghost" onClick={() => setImporting(true)}>
            <Upload size={15} aria-hidden="true" />
            Import CSV
          </button>
          <button type="button" className="ghost" onClick={() => setEnrolling(true)}>
            Enrolment tokens
          </button>
        </div>

        <InfoPanel page="directory">
          Users, groups, computers and organizational units, in the tree they live in. An
          organizational unit is what policy links to and what delegation is scoped by.
        </InfoPanel>

        <p className="mono muted breadcrumb">{search ? `Search: ${search}` : container}</p>

        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="muted">{notice}</p>}

        {chosen.size > 0 && (
          <div className="actions-row">
            <strong>{chosen.size} selected</strong>
            <button type="button" className="primary" onClick={() => setBulk(true)}>
              Change all of them…
            </button>
            <button type="button" className="ghost" onClick={() => setChosen(new Set())}>
              Clear
            </button>
          </div>
        )}

        <table className="data">
          <thead>
            <tr>
              <th scope="col" style={{ width: "36px" }}>
                <input
                  type="checkbox"
                  aria-label="Select everything listed"
                  checked={chosen.size > 0 && chosen.size === objects.length}
                  ref={(box) => {
                    if (box) box.indeterminate = chosen.size > 0 && chosen.size < objects.length;
                  }}
                  onChange={(event) =>
                    setChosen(
                      event.target.checked
                        ? new Set(objects.map((object) => object.distinguishedName))
                        : new Set(),
                    )
                  }
                />
              </th>
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
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(DN_MEDIA_TYPE, object.distinguishedName);
                  }}
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
                  <td onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${label(object)}`}
                      checked={chosen.has(object.distinguishedName)}
                      onChange={(event) => {
                        const next = new Set(chosen);
                        if (event.target.checked) next.add(object.distinguishedName);
                        else next.delete(object.distinguishedName);
                        setChosen(next);
                      }}
                    />
                  </td>
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
                <td colSpan={5} className="empty">
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

      {enrolling && <EnrolmentTokens container={container} onClose={() => setEnrolling(false)} />}

      {menu}

      {bulk && (
        <BulkDialog
          dns={[...chosen]}
          onClose={() => setBulk(false)}
          onDone={(message) => {
            setBulk(false);
            setChosen(new Set());
            setNotice(message);
            void refresh();
          }}
        />
      )}

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
  baseDn,
  rootLabel,
  selected,
  menuFor,
  bind,
  onSelect,
  onMove,
}: {
  nodes: DirectoryObject[];
  dn: string;
  baseDn: string;
  rootLabel?: string;
  selected: string;
  menuFor: (node: DirectoryObject) => MenuItem[];
  bind: (items: MenuItem[]) => { onContextMenu: (event: React.MouseEvent) => void };
  onSelect: (dn: string) => void;
  onMove: (sourceDn: string, targetDn: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const self = nodes.find((n) => n.distinguishedName === dn);
  // ponytail: O(n) scan per node. Directory trees are tens to hundreds of
  // containers; build a parent index here if that stops being true.
  const children = nodes.filter(
    (n) => parentOf(n.distinguishedName).toLowerCase() === dn.toLowerCase(),
  );
  const name = self ? rootLabel ?? label(self) : "";
  // Remembered position, made visible: a container several levels down is of
  // no use if the pane is still scrolled to the top of the domain.
  useEffect(() => {
    if (selected === dn) row.current?.scrollIntoView({ block: "nearest" });
  }, [selected, dn]);

  if (!self) return null;
  const builtin = isBuiltin(self, baseDn);

  const rowClass = [selected === dn ? "tree-row active" : "tree-row", dragOver && "drag-over"]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="tree-node">
      <div
        ref={row}
        className={rowClass}
        {...bind(menuFor(self))}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(DN_MEDIA_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes(DN_MEDIA_TYPE)) return;
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          setDragOver(false);
          const sourceDn = event.dataTransfer.getData(DN_MEDIA_TYPE);
          if (!sourceDn) return;
          event.preventDefault();
          onMove(sourceDn, dn);
        }}
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
        <button
          type="button"
          className="tree-label"
          draggable={self.objectType === "ou" && !builtin}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(DN_MEDIA_TYPE, dn);
          }}
          onClick={() => onSelect(dn)}
        >
          {/* Filled for what the directory brought with it, outline for what
              somebody here made. Which is which matters when deciding what is
              safe to move or rename. */}
          <Folder
            size={14}
            aria-hidden="true"
            className={builtin ? "folder-builtin" : "folder-custom"}
            fill={builtin ? "currentColor" : "none"}
          />
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
              baseDn={baseDn}
              selected={selected}
              menuFor={menuFor}
              bind={bind}
              onSelect={onSelect}
              onMove={onMove}
            />
          ))}
        </div>
      )}
    </div>
  );
}


/**
 * One change, applied to everything selected.
 *
 * Each object is its own success or failure: one that cannot be changed —
 * protected, gone, outside the caller's scope — is reported by name and the
 * rest still happen. Stopping at the first failure in a run of five hundred
 * leaves nobody able to say what did and did not.
 */
function BulkDialog({
  dns,
  onClose,
  onDone,
}: {
  dns: string[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [field, setField] = useState("department");
  const [value, setValue] = useState("");
  const [addGroup, setAddGroup] = useState("");
  const [removeGroup, setRemoveGroup] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [enabled, setEnabled] = useState<"" | "yes" | "no">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ dn: string; reason: string }[]>([]);

  const nothing = !value && !addGroup && !removeGroup && !moveTo && !enabled;

  return (
    <Modal
      title={`Change ${dns.length} object${dns.length === 1 ? "" : "s"}`}
      submitLabel={busy ? "Applying…" : "Apply"}
      onClose={onClose}
      onSubmit={async () => {
        if (nothing || busy) return;
        setBusy(true);
        setError(null);
        try {
          const result = await api.directory.bulk({
            dns,
            changes: value ? { [field]: value } : {},
            add_groups: addGroup ? [addGroup] : [],
            remove_groups: removeGroup ? [removeGroup] : [],
            move_to: moveTo || null,
            enabled: enabled === "" ? null : enabled === "yes",
          });
          if (result.problems.length > 0) {
            setProblems(result.problems);
            setBusy(false);
            return;
          }
          onDone(`${result.changed.length} object(s) changed.`);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
          setBusy(false);
        }
      }}
    >
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {problems.length > 0 && (
        <>
          <p className="alert" role="alert">
            {problems.length} object(s) were refused. Everything else was changed.
          </p>
          <pre className="command-output">
            {problems.map((problem) => `${problem.dn}\n  ${problem.reason}`).join("\n")}
          </pre>
        </>
      )}

      <p className="muted">
        Leave anything empty to leave it alone. A value set here replaces what each object has;
        an empty one does not clear it.
      </p>

      <div className="field-grid">
        <Field label="Set">
          <Select value={field} onChange={(e) => setField(e.target.value)}>
            <option value="department">Department</option>
            <option value="title">Title</option>
            <option value="company">Company</option>
            <option value="physicalDeliveryOfficeName">Office</option>
            <option value="description">Description</option>
          </Select>
        </Field>
        <Field label="To">
          <input value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>

      <div className="field-grid">
        <Field label="Add to group">
          <PickerField
            kind="group"
            as="dn"
            ariaLabel="Add to group"
            value={addGroup}
            onChange={setAddGroup}
          />
        </Field>
        <Field label="Remove from group">
          <PickerField
            kind="group"
            as="dn"
            ariaLabel="Remove from group"
            value={removeGroup}
            onChange={setRemoveGroup}
          />
        </Field>
      </div>

      <div className="field-grid">
        <Field label="Move to">
          <PickerField
            kind="ou"
            as="dn"
            ariaLabel="Move to"
            value={moveTo}
            onChange={setMoveTo}
          />
        </Field>
        <Field label="Account state">
          <Select value={enabled} onChange={(e) => setEnabled(e.target.value as "" | "yes" | "no")}>
            <option value="">Leave as it is</option>
            <option value="yes">Enable</option>
            <option value="no">Disable</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
