import { useCallback, useEffect, useState } from "react";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import {
  ApiError,
  api,
  type DirectoryObject,
  type RbacAssignment,
  type RbacRole,
} from "../api";
import { Field, Modal } from "../components/Modal";

type Tab = "assignments" | "roles";

export function Delegation() {
  const [tab, setTab] = useState<Tab>("assignments");
  const [roles, setRoles] = useState<RbacRole[]>([]);
  const [assignments, setAssignments] = useState<RbacAssignment[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [dialog, setDialog] = useState<"assign" | "role" | null>(null);
  const [openRole, setOpenRole] = useState<RbacRole | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [roleList, assignmentList, permissionList] = await Promise.all([
        api.rbac.roles(),
        api.rbac.assignments(),
        api.rbac.permissions(),
      ]);
      setRoles(roleList.roles);
      setAssignments(assignmentList.assignments);
      setPermissions(permissionList.permissions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <main className="content">
      <div className="page-header">
        <h1>Delegation</h1>
        <span className="spacer" />
        <button
          type="button"
          className="primary"
          onClick={() => setDialog(tab === "roles" ? "role" : "assign")}
        >
          <Plus size={15} aria-hidden="true" />
          {tab === "roles" ? "New role" : "New assignment"}
        </button>
      </div>
      <p className="muted">
        A role holds permissions. An assignment grants a role to a user or group at an
        organizational unit, and applies to that unit and everything beneath it.
      </p>

      <nav className="tabs" aria-label="Delegation views">
        {(["assignments", "roles"] as Tab[]).map((current) => (
          <button
            key={current}
            type="button"
            className={tab === current ? "tab active" : "tab"}
            aria-current={tab === current ? "true" : undefined}
            onClick={() => setTab(current)}
          >
            {current === "assignments" ? "Assignments" : "Roles"}
          </button>
        ))}
      </nav>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {tab === "assignments" && (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Principal</th>
              <th scope="col">Role</th>
              <th scope="col">Scope</th>
              <th scope="col">Granted by</th>
              <th scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((assignment) => (
              <tr key={assignment.id}>
                <td>
                  <strong>{assignment.principal_name}</strong>
                  <p className="mono muted">{assignment.principal_sid}</p>
                </td>
                <td>{assignment.role_name}</td>
                <td className="mono">{assignment.scope_dn}</td>
                <td>{assignment.granted_by}</td>
                <td>
                  <button
                    type="button"
                    className="icon"
                    aria-label={`Revoke ${assignment.role_name} from ${assignment.principal_name}`}
                    onClick={() => void run(() => api.rbac.unassign(assignment.id))}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
            {assignments.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  Nothing delegated. Only members of the domain administrators group can sign in.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {/* A role's permission list runs to a dozen strings. The table carries
          the count; the list itself is one click away. */}
      {tab === "roles" && (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Description</th>
              <th scope="col">Permissions</th>
              <th scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role.name} onClick={() => setOpenRole(role)}>
                <td>
                  {role.builtin && <ShieldCheck size={14} aria-hidden="true" />}
                  <strong>{role.name}</strong>
                </td>
                <td>{role.description}</td>
                <td>
                  {role.permissions.includes("*")
                    ? "Everything"
                    : `${role.permissions.length} permissions`}
                </td>
                <td>
                  {!role.builtin && (
                    <button
                      type="button"
                      className="icon"
                      aria-label={`Delete role ${role.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void run(() => api.rbac.deleteRole(role.name));
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {openRole && (
        <Modal
          title={openRole.name}
          submitLabel="Close"
          onClose={() => setOpenRole(null)}
          onSubmit={() => setOpenRole(null)}
        >
          <p>{openRole.description}</p>
          <h3 className="section-title">Permissions</h3>
          <ul className="permission-list">
            {(openRole.permissions.includes("*")
              ? ["every permission in the console"]
              : openRole.permissions
            ).map((permission) => (
              <li key={permission} className="mono">
                {permission}
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {dialog === "assign" && (
        <AssignDialog
          roles={roles}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog === "role" && (
        <RoleDialog
          permissions={permissions}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
    </main>
  );
}

function AssignDialog({
  roles,
  onClose,
  onSaved,
}: {
  roles: RbacRole[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [roleName, setRoleName] = useState(roles[0]?.name ?? "");
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<DirectoryObject[]>([]);
  const [principal, setPrincipal] = useState<DirectoryObject | null>(null);
  const [containers, setContainers] = useState<string[]>([]);
  const [scope, setScope] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.directory
      .tree()
      .then((tree) => {
        setContainers(tree.nodes.map((node) => node.distinguishedName));
        setScope((current) => current || tree.base_dn);
      })
      .catch(() => setContainers([]));
  }, []);

  useEffect(() => {
    if (search.trim().length < 2) {
      setCandidates([]);
      return;
    }
    const timer = setTimeout(() => {
      void api.directory
        .list({ query: search, scope: "subtree" })
        .then((result) =>
          setCandidates(
            result.objects.filter((o) => o.objectType === "user" || o.objectType === "group"),
          ),
        )
        .catch(() => setCandidates([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <Modal
      title="Delegate a role"
      submitLabel="Assign"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        if (!principal) {
          setError("Choose a user or group first.");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await api.rbac.assign({
            role_name: roleName,
            principal_dn: principal.distinguishedName,
            scope_dn: scope,
            description,
          });
          onSaved();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Role">
        <select value={roleName} onChange={(e) => setRoleName(e.target.value)}>
          {roles.map((role) => (
            <option key={role.name} value={role.name}>
              {role.name} — {role.description}
            </option>
          ))}
        </select>
      </Field>

      <Field label="User or group" hint="Search the directory by name">
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </Field>
      {principal && <p className="mono muted">{principal.distinguishedName}</p>}
      {candidates.length > 0 && (
        <ul className="picker">
          {candidates.map((candidate) => (
            <li key={candidate.distinguishedName}>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setPrincipal(candidate);
                  setCandidates([]);
                  setSearch(String(candidate.sAMAccountName ?? candidate.cn ?? ""));
                }}
              >
                {String(candidate.sAMAccountName ?? candidate.cn)} — {candidate.objectType}
              </button>
            </li>
          ))}
        </ul>
      )}

      <Field label="Scope" hint="The role applies here and everywhere beneath">
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          {containers.map((dn) => (
            <option key={dn} value={dn}>
              {dn}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Note">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </Modal>
  );
}

function RoleDialog({
  permissions,
  onClose,
  onSaved,
}: {
  permissions: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="New role"
      submitLabel="Create"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.rbac.saveRole(name, description, chosen);
          onSaved();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name" hint="Lower case letters, digits and dashes">
        <input value={name} required onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Permissions">
        <div className="permission-grid">
          {permissions.map((permission) => (
            <label key={permission} className="checkbox">
              <input
                type="checkbox"
                checked={chosen.includes(permission)}
                onChange={(e) =>
                  setChosen(
                    e.target.checked
                      ? [...chosen, permission]
                      : chosen.filter((p) => p !== permission),
                  )
                }
              />
              <span className="mono">{permission}</span>
            </label>
          ))}
        </div>
      </Field>
    </Modal>
  );
}
