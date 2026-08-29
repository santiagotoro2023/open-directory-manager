import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Folder,
  Monitor,
  RefreshCw,
  ShieldCheck,
  User,
  Users,
} from "lucide-react";
import {
  ApiError,
  api,
  type ComputerDetail,
  type DirectoryObject,
} from "../api";
import { Field } from "../components/Modal";
import { RsopDialog } from "../components/RsopDialog";
import {
  DeleteDialog,
  EDITABLE,
  GROUP_KIND_LABELS,
  GROUP_SCOPES,
  MembersDialog,
  MoveDialog,
  PasswordDialog,
  isDisabled,
  text,
} from "../components/objectDialogs";

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

type Tab = "general" | "membership" | "policy" | "machine" | "users" | "activity";

function when(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * One object, on a page of its own.
 *
 * A user has a dozen attributes; a computer has those plus its local accounts,
 * its sessions and its history. None of that fits a dialog, and a dialog over
 * the list is the wrong shape for something an operator stays in.
 */
export function ObjectDetail() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const dn = params.get("dn") ?? "";

  const [object, setObject] = useState<DirectoryObject | null>(null);
  const [containers, setContainers] = useState<DirectoryObject[]>([]);
  const [tab, setTab] = useState<Tab>("general");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<
    "password" | "move" | "members" | "delete" | "rsop" | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const fresh = await api.directory.get(dn);
      setObject(fresh);
      const fields = EDITABLE[fresh.objectType] ?? [];
      setDraft(Object.fromEntries(fields.map((f) => [f.attribute, text(fresh[f.attribute])])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [dn]);

  useEffect(() => {
    void load();
    api.directory
      .tree()
      .then((tree) => setContainers(tree.nodes))
      .catch(() => setContainers([]));
  }, [load]);

  if (!object) {
    return (
      <main className="content">
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </main>
    );
  }

  const fields = EDITABLE[object.objectType] ?? [];
  const isAccount = object.objectType === "user" || object.objectType === "computer";
  const isComputer = object.objectType === "computer";
  const Icon = ICONS[object.objectType as keyof typeof ICONS] ?? Folder;

  const tabs: { id: Tab; label: string }[] = [
    { id: "general", label: "General" },
    ...(object.objectType === "group"
      ? [{ id: "membership" as Tab, label: "Members" }]
      : [{ id: "membership" as Tab, label: "Member of" }]),
    { id: "policy", label: "Policy" },
    ...(isComputer
      ? [
          { id: "machine" as Tab, label: "Machine" },
          { id: "users" as Tab, label: "Local users" },
          { id: "activity" as Tab, label: "Activity" },
        ]
      : []),
  ];

  async function run<T>(action: () => Promise<T>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await action();
      await load();
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
      if (next !== text(object![attribute])) changes[attribute] = next === "" ? null : next;
    }
    if (Object.keys(changes).length === 0) {
      setSaved(true);
      return;
    }
    void run(async () => {
      await api.directory.update(dn, changes);
      setSaved(true);
    });
  }

  return (
    <main className="content">
      <div className="page-header">
        <button type="button" className="ghost" onClick={() => navigate("/directory")}>
          <ArrowLeft size={15} aria-hidden="true" />
          Directory
        </button>
        <h1>
          <Icon size={20} aria-hidden="true" />{" "}
          {text(object.displayName || object.cn || object.ou)}
        </h1>
        {isDisabled(object) && <span className="badge">Disabled</span>}
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => setDialog("move")}>
          Move
        </button>
        <button type="button" className="danger" onClick={() => setDialog("delete")}>
          Delete
        </button>
        <button type="button" className="primary" disabled={busy} onClick={save}>
          Save
        </button>
      </div>
      <p className="mono muted">{dn}</p>

      <nav className="tabs" aria-label="Object sections">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={tab === entry.id ? "tab active" : "tab"}
            aria-current={tab === entry.id ? "true" : undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {saved && <p className="muted">Saved.</p>}

      {tab === "general" && (
        <>
          <h3 className="section-title">Identity</h3>
          <dl className="definition">
            <dt>Type</dt>
            <dd>
              {object.objectType === "group"
                ? GROUP_KIND_LABELS[String(object.groupKind ?? "user")]
                : (TYPE_LABELS[object.objectType] ?? object.objectType)}
            </dd>
            {isAccount && (
              <>
                <dt>Account name</dt>
                <dd className="mono">{text(object.sAMAccountName)}</dd>
                <dt>Status</dt>
                <dd>{isDisabled(object) ? "Disabled" : "Enabled"}</dd>
              </>
            )}
            {object.objectType === "group" && (
              <>
                <dt>Scope</dt>
                <dd>{GROUP_SCOPES[Number(object.groupType)] ?? "unknown"}</dd>
                <dt>Members</dt>
                <dd>{(object.member as string[] | undefined)?.length ?? 0}</dd>
              </>
            )}
          </dl>

          <h3 className="section-title">Attributes</h3>
          <div className="field-grid">
            {fields.map(({ attribute, label }) => (
              <Field key={attribute} label={label}>
                <input
                  value={draft[attribute] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [attribute]: e.target.value })}
                />
              </Field>
            ))}
          </div>

          {object.objectType === "group" && (
            <>
              <h3 className="section-title">Group type</h3>
              <select
                aria-label="Group type"
                value={String(object.groupKind ?? "user")}
                disabled={busy}
                onChange={(e) =>
                  void run(() =>
                    api.directory.setGroupKind(dn, e.target.value as "user" | "computer"),
                  )
                }
              >
                <option value="user">User group</option>
                <option value="computer">Computer group</option>
              </select>
            </>
          )}

          <h3 className="section-title">Actions</h3>
          <div className="actions-row">
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
                onClick={() => void run(() => api.directory.setEnabled(dn, isDisabled(object)))}
              >
                {isDisabled(object) ? "Enable" : "Disable"}
              </button>
            )}
            {object.objectType === "ou" && (
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void run(() => api.policy.setInheritance(dn, true))}
              >
                <ShieldCheck size={15} aria-hidden="true" />
                Block inheritance
              </button>
            )}
          </div>
        </>
      )}

      {tab === "membership" && (
        <MembershipTab object={object} onChanged={() => void load()} />
      )}

      {tab === "policy" && (
        <RsopDialog dn={dn} isComputer={isComputer} onClose={() => setTab("general")} inline />
      )}

      {isComputer && (tab === "machine" || tab === "users" || tab === "activity") && (
        <ComputerTabs dn={dn} tab={tab} />
      )}

      {dialog === "password" && <PasswordDialog dn={dn} onClose={() => setDialog(null)} />}
      {dialog === "move" && (
        <MoveDialog
          object={object}
          containers={containers}
          onClose={() => setDialog(null)}
          onMoved={(moved) => {
            setDialog(null);
            navigate(`/directory/object?dn=${encodeURIComponent(moved.distinguishedName)}`, {
              replace: true,
            });
          }}
        />
      )}
      {dialog === "members" && (
        <MembersDialog
          group={object}
          onClose={() => setDialog(null)}
          onChanged={() => void load()}
        />
      )}
      {dialog === "delete" && (
        <DeleteDialog
          object={object}
          onClose={() => setDialog(null)}
          onDeleted={() => navigate("/directory")}
        />
      )}
    </main>
  );
}

function MembershipTab({
  object,
  onChanged,
}: {
  object: DirectoryObject;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const isGroup = object.objectType === "group";
  const entries = isGroup
    ? ((object.member as string[] | undefined) ?? [])
    : ((object.memberOf as string[] | undefined) ?? []);

  return (
    <>
      <div className="actions-row">
        {isGroup && (
          <button type="button" className="primary" onClick={() => setEditing(true)}>
            Edit members
          </button>
        )}
      </div>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">{isGroup ? "Member" : "Group"}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry}>
              <td className="mono">{entry}</td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td className="empty">{isGroup ? "No members." : "In no groups."}</td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <MembersDialog
          group={object}
          onClose={() => setEditing(false)}
          onChanged={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function ComputerTabs({ dn, tab }: { dn: string; tab: Tab }) {
  const [detail, setDetail] = useState<ComputerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await api.servers.computer(dn));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [dn]);

  useEffect(() => {
    void load();
  }, [load]);

  async function ask(action: "update-check" | "update-install") {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api.servers.action(dn, action);
      setNotice(
        `Queued for ${result.node}. It runs at the machine's next check-in, or immediately with odm-agent apply --force.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }
  if (!detail) return <p className="muted">Loading…</p>;
  if (!detail.known) {
    return (
      <p className="empty">
        This machine has not reported yet. Its agent sends this on its first check-in.
      </p>
    );
  }

  const facts = detail.facts!;

  if (tab === "users") {
    return (
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">UID</th>
            <th scope="col">Groups</th>
            <th scope="col">Shell</th>
          </tr>
        </thead>
        <tbody>
          {facts.local_users.map((user) => (
            <tr key={user.name}>
              <td>{user.name}</td>
              <td>{user.uid}</td>
              <td>{user.groups.join(", ") || "—"}</td>
              <td className="mono">{user.shell}</td>
            </tr>
          ))}
          {facts.local_users.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                No local accounts outside the system range.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    );
  }

  if (tab === "activity") {
    return (
      <>
        <h3 className="section-title">Signed in now</h3>
        <table className="data compact">
          <tbody>
            {facts.sessions.map((session, index) => (
              <tr key={index}>
                <td>{session.user}</td>
                <td className="mono">{session.line}</td>
                <td>{session.since}</td>
              </tr>
            ))}
            {facts.sessions.length === 0 && (
              <tr>
                <td className="empty">Nobody is signed in.</td>
              </tr>
            )}
          </tbody>
        </table>

        <h3 className="section-title">History</h3>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What</th>
              <th scope="col">Who</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {detail.events.map((event, index) => (
              <tr key={index}>
                <td>{when(event.occurred_at)}</td>
                <td>{event.kind}</td>
                <td>{event.principal || "—"}</td>
                <td className="mono">{event.detail ?? ""}</td>
              </tr>
            ))}
            {detail.events.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  Nothing recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </>
    );
  }

  return (
    <>
      {notice && <p className="muted">{notice}</p>}

      <h3 className="section-title">Machine</h3>
      <dl className="definition">
        <dt>Host name</dt>
        <dd className="mono">{facts.hostname}</dd>
        <dt>Operating system</dt>
        <dd>{facts.operating_system || "not reported"}</dd>
        <dt>Kernel</dt>
        <dd className="mono">{facts.kernel || "not reported"}</dd>
        <dt>Booted</dt>
        <dd>{when(facts.booted_at)}</dd>
        <dt>Last reported</dt>
        <dd>{when(facts.reported_at)}</dd>
      </dl>

      <h3 className="section-title">Updates</h3>
      <dl className="definition">
        <dt>Waiting</dt>
        <dd>
          {facts.pending_updates === 0
            ? "Up to date"
            : `${facts.pending_updates} packages, ${facts.security_updates} from security`}
        </dd>
        <dt>Last checked</dt>
        <dd>{when(facts.updates_checked_at)}</dd>
      </dl>
      {facts.updates.length > 0 && (
        <p className="mono muted">{facts.updates.join(", ")}</p>
      )}
      <div className="actions-row">
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void ask("update-check")}
        >
          <RefreshCw size={15} aria-hidden="true" />
          Check for updates
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void ask("update-install")}
        >
          Install updates
        </button>
      </div>

      <h3 className="section-title">Recent work</h3>
      <table className="data compact">
        <thead>
          <tr>
            <th scope="col">Requested</th>
            <th scope="col">What</th>
            <th scope="col">State</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {detail.tasks.map((task) => (
            <tr key={task.id}>
              <td>{when(task.created_at)}</td>
              <td>{task.kind}</td>
              <td>
                <span className={`badge ${task.state === "done" ? "success" : ""}`}>
                  {task.state}
                </span>
              </td>
              <td className="mono">{task.output ?? ""}</td>
            </tr>
          ))}
          {detail.tasks.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                Nothing has been asked of this machine.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
