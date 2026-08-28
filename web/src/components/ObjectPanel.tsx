import { useEffect, useState } from "react";
import { ApiError, api, type DirectoryObject } from "../api";
import { Field, Modal } from "./Modal";
import { RsopDialog } from "./RsopDialog";

// Mirrors the per-type allow-lists the API enforces; anything else is
// rejected server-side, so the form never offers it.
const EDITABLE: Record<string, { attribute: string; label: string }[]> = {
  user: [
    { attribute: "givenName", label: "First name" },
    { attribute: "sn", label: "Last name" },
    { attribute: "displayName", label: "Display name" },
    { attribute: "userPrincipalName", label: "User principal name" },
    { attribute: "mail", label: "E-mail" },
    { attribute: "telephoneNumber", label: "Telephone" },
    { attribute: "title", label: "Title" },
    { attribute: "department", label: "Department" },
    { attribute: "company", label: "Company" },
    { attribute: "physicalDeliveryOfficeName", label: "Office" },
    { attribute: "description", label: "Description" },
  ],
  group: [
    { attribute: "description", label: "Description" },
    { attribute: "mail", label: "E-mail" },
  ],
  computer: [
    { attribute: "dNSHostName", label: "DNS host name" },
    { attribute: "description", label: "Description" },
  ],
  ou: [{ attribute: "description", label: "Description" }],
};

const GROUP_SCOPES: Record<number, string> = {
  [-2147483646]: "Global",
  [-2147483644]: "Domain local",
  [-2147483640]: "Universal",
};

const GROUP_KIND_LABELS: Record<string, string> = {
  user: "User group",
  computer: "Computer group",
};

const UF_ACCOUNTDISABLE = 0x0002;

export function isDisabled(object: DirectoryObject): boolean {
  const uac = Number(object.userAccountControl ?? 0);
  return Boolean(uac & UF_ACCOUNTDISABLE);
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

export function ObjectPanel({
  object,
  containers,
  onChanged,
  onDeleted,
  onClose,
}: {
  object: DirectoryObject;
  containers: DirectoryObject[];
  onChanged: (updated: DirectoryObject) => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const dn = object.distinguishedName;
  const fields = EDITABLE[object.objectType] ?? [];
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<
    "password" | "move" | "members" | "delete" | "rsop" | null
  >(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    setDraft(Object.fromEntries(fields.map((f) => [f.attribute, text(object[f.attribute])])));
    setError(null);
  }, [dn]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run<T>(action: () => Promise<T>, after?: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      after?.(await action());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const changes: Record<string, string | null> = {};
    for (const { attribute } of fields) {
      const next = draft[attribute] ?? "";
      if (next !== text(object[attribute])) changes[attribute] = next === "" ? null : next;
    }
    if (Object.keys(changes).length === 0) return;
    void run(() => api.directory.update(dn, changes), onChanged);
  }

  const isAccount = object.objectType === "user" || object.objectType === "computer";

  return (
    <aside className="panel" aria-label="Object details">
      <header>
        <div>
          <h2>{text(object.displayName || object.cn || object.ou)}</h2>
          <p className="mono muted">{dn}</p>
        </div>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </header>

      {object.objectType === "group" && (
        <>
          <p className="muted">
            {GROUP_KIND_LABELS[String(object.groupKind ?? "user")]} ·{" "}
            {GROUP_SCOPES[Number(object.groupType)] ?? "unknown scope"} ·{" "}
            {(object.member as string[] | undefined)?.length ?? 0} members
          </p>
          <label className="field">
            <span>Group type</span>
            <select
              value={String(object.groupKind ?? "user")}
              disabled={busy}
              onChange={(e) =>
                void run(
                  () => api.directory.setGroupKind(dn, e.target.value as "user" | "computer"),
                  onChanged,
                )
              }
            >
              <option value="user">User group</option>
              <option value="computer">Computer group</option>
            </select>
          </label>
        </>
      )}
      {isAccount && (
        <p className="muted">
          {text(object.sAMAccountName)} · {isDisabled(object) ? "Disabled" : "Enabled"}
        </p>
      )}

      <div className="panel-fields">
        {fields.map(({ attribute, label }) => (
          <Field key={attribute} label={label}>
            <input
              value={draft[attribute] ?? ""}
              onChange={(e) => setDraft({ ...draft, [attribute]: e.target.value })}
            />
          </Field>
        ))}
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <div className="panel-actions">
        <button type="button" className="primary" onClick={save} disabled={busy}>
          Save
        </button>
        {object.objectType === "group" && (
          <button type="button" className="ghost" onClick={() => setDialog("members")}>
            Members
          </button>
        )}
        {object.objectType === "user" && (
          <button type="button" className="ghost" onClick={() => setDialog("password")}>
            Reset password
          </button>
        )}
        {isAccount && (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run(() => api.directory.setEnabled(dn, isDisabled(object)), onChanged)
            }
          >
            {isDisabled(object) ? "Enable" : "Disable"}
          </button>
        )}
        <button type="button" className="ghost" onClick={() => setDialog("rsop")}>
          Policy
        </button>
        {object.objectType === "ou" && (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run(
                () => api.policy.setInheritance(dn, !blocked),
                (result) => setBlocked(result.block_inheritance),
              )
            }
          >
            {blocked ? "Allow inheritance" : "Block inheritance"}
          </button>
        )}
        <button type="button" className="ghost" onClick={() => setDialog("move")}>
          Move
        </button>
        <button type="button" className="danger" onClick={() => setDialog("delete")}>
          Delete
        </button>
      </div>

      {dialog === "rsop" && (
        <RsopDialog
          dn={dn}
          isComputer={object.objectType === "computer"}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "password" && (
        <PasswordDialog dn={dn} onClose={() => setDialog(null)} />
      )}
      {dialog === "move" && (
        <MoveDialog
          object={object}
          containers={containers}
          onClose={() => setDialog(null)}
          onMoved={(moved) => {
            setDialog(null);
            onChanged(moved);
          }}
        />
      )}
      {dialog === "members" && (
        <MembersDialog
          group={object}
          onClose={() => setDialog(null)}
          onChanged={(updated) => onChanged(updated)}
        />
      )}
      {dialog === "delete" && (
        <DeleteDialog
          object={object}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            onDeleted();
          }}
        />
      )}
    </aside>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function PasswordDialog({ dn, onClose }: { dn: string; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const { busy, error, run } = useAction();

  return (
    <Modal
      title="Reset password"
      submitLabel="Reset"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void run(async () => {
          await api.directory.setPassword(dn, password, mustChange);
          onClose();
        })
      }
    >
      <Field label="New password">
        <input
          type="password"
          value={password}
          autoComplete="new-password"
          required
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={mustChange}
          onChange={(e) => setMustChange(e.target.checked)}
        />
        User must change password at next logon
      </label>
    </Modal>
  );
}

function MoveDialog({
  object,
  containers,
  onClose,
  onMoved,
}: {
  object: DirectoryObject;
  containers: DirectoryObject[];
  onClose: () => void;
  onMoved: (moved: DirectoryObject) => void;
}) {
  const dn = object.distinguishedName;
  const parent = dn.slice(dn.indexOf(",") + 1);
  const [target, setTarget] = useState(parent);
  const { busy, error, run } = useAction();

  return (
    <Modal
      title="Move object"
      submitLabel="Move"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void run(async () => onMoved(await api.directory.move(dn, target)))
      }
    >
      <Field label="Destination">
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {containers.map((c) => (
            <option key={c.distinguishedName} value={c.distinguishedName}>
              {c.distinguishedName}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

function MembersDialog({
  group,
  onClose,
  onChanged,
}: {
  group: DirectoryObject;
  onClose: () => void;
  onChanged: (updated: DirectoryObject) => void;
}) {
  const dn = group.distinguishedName;
  const [members, setMembers] = useState<string[]>((group.member as string[] | undefined) ?? []);
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<DirectoryObject[]>([]);
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (search.trim().length < 2) {
      setCandidates([]);
      return;
    }
    const wanted = group.groupKind === "computer" ? "computer" : "user";
    const timer = setTimeout(() => {
      void api.directory
        .list({ query: search, scope: "subtree" })
        .then((result) =>
          // A user group offers people and other groups; a computer group
          // offers machines and other groups.
          setCandidates(
            result.objects.filter(
              (object) => object.objectType === wanted || object.objectType === "group",
            ),
          ),
        )
        .catch(() => setCandidates([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [search, group.groupKind]);

  const pending = [...members.filter((m) => !remove.includes(m)), ...add];

  return (
    <Modal
      title={`Members of ${String(group.cn ?? "")}`}
      submitLabel="Apply"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void run(async () => {
          const updated = await api.directory.editMembers(dn, add, remove);
          setMembers((updated.member as string[] | undefined) ?? []);
          onChanged(updated);
          onClose();
        })
      }
    >
      <Field
        label="Add member"
        hint={
          group.groupKind === "computer"
            ? "Search computers and groups by name"
            : "Search users and groups by name"
        }
      >
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </Field>
      {candidates.length > 0 && (
        <ul className="picker">
          {candidates.map((c) => (
            <li key={c.distinguishedName}>
              <button
                type="button"
                className="ghost"
                disabled={pending.includes(c.distinguishedName)}
                onClick={() => setAdd([...add, c.distinguishedName])}
              >
                {String(c.sAMAccountName ?? c.cn)} — {c.objectType}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="muted">{pending.length} members</p>
      <ul className="member-list">
        {pending.map((member) => (
          <li key={member}>
            <span className="mono">{member}</span>
            <button
              type="button"
              className="icon"
              aria-label={`Remove ${member}`}
              onClick={() =>
                add.includes(member)
                  ? setAdd(add.filter((m) => m !== member))
                  : setRemove([...remove, member])
              }
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function DeleteDialog({
  object,
  onClose,
  onDeleted,
}: {
  object: DirectoryObject;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { busy, error, run } = useAction();
  return (
    <Modal
      title="Delete object"
      submitLabel="Delete"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void run(async () => {
          await api.directory.remove(object.distinguishedName);
          onDeleted();
        })
      }
    >
      <p>
        Delete <strong>{String(object.cn ?? object.ou)}</strong>?
      </p>
      <p className="muted mono">{object.distinguishedName}</p>
      <p className="muted">
        The object is snapshotted to the recycle bin before removal and can be restored within the
        retention window.
      </p>
    </Modal>
  );
}
