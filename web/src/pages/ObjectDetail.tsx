import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Folder,
  KeyRound,
  Monitor,
  Power,
  RefreshCw,
  ShieldCheck,
  User,
  Users,
} from "lucide-react";
import {
  ApiError,
  api,
  type ComputerAction,
  type ComputerDetail,
  type DirectoryObject,
  type LogGroup,
} from "../api";
import { Field, Modal } from "../components/Modal";
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

type Tab =
  "general" | "membership" | "policy" | "machine" | "software" | "users" | "activity" | "logs";

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
  const [dialog, setDialog] = useState<"password" | "move" | "members" | "delete" | "rsop" | null>(
    null,
  );
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
          { id: "software" as Tab, label: "Software" },
          { id: "users" as Tab, label: "Local users" },
          { id: "activity" as Tab, label: "Activity" },
          { id: "logs" as Tab, label: "Logs" },
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
          <Icon size={20} aria-hidden="true" /> {text(object.displayName || object.cn || object.ou)}
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

      {tab === "membership" && <MembershipTab object={object} onChanged={() => void load()} />}

      {tab === "policy" && (
        <RsopDialog dn={dn} isComputer={isComputer} onClose={() => setTab("general")} inline />
      )}

      {isComputer &&
        (tab === "machine" || tab === "software" || tab === "users" || tab === "activity") && (
          <ComputerTabs dn={dn} tab={tab} />
        )}

      {isComputer && tab === "logs" && <LogsTab dn={dn} />}

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

/**
 * The machine's own local administrator, and its password.
 *
 * Hidden until asked for, because every read is audited: rendering it with
 * the rest of the page would fill the log with reads nobody made. What comes
 * back is what the machine last generated, so it is the password that works
 * right now even if the domain is unreachable from it.
 */
function LocalAdministratorPanel({ dn }: { dn: string }) {
  const [shown, setShown] = useState<Awaited<
    ReturnType<typeof api.servers.localAdministrator>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      setShown(await api.servers.localAdministrator(dn));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3 className="section-title">Local administrator</h3>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!shown ? (
        <div className="actions-row">
          <button type="button" className="ghost" disabled={busy} onClick={() => void reveal()}>
            <KeyRound size={15} aria-hidden="true" />
            Show the password
          </button>
          <span className="muted">Every read is recorded in the audit log.</span>
        </div>
      ) : !shown.configured ? (
        <p className="empty">
          No password has been reported. Set one under Group Policy &rarr; Computer &rarr; Local
          administrator, and it appears after the machine&rsquo;s next check-in.
        </p>
      ) : (
        <dl className="definition">
          <dt>Account</dt>
          <dd className="mono">{shown.account}</dd>
          <dt>Password</dt>
          <dd className="mono selectable">{shown.password}</dd>
          <dt>Rotated</dt>
          <dd>{when(shown.rotated_at)}</dd>
          <dt>Rotates again</dt>
          <dd>{when(shown.expires_at)}</dd>
        </dl>
      )}
    </>
  );
}

function MembershipTab({ object, onChanged }: { object: DirectoryObject; onChanged: () => void }) {
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
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [power, setPower] = useState<"restart" | "shutdown" | null>(null);

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

  async function ask(action: ComputerAction, pkg?: string) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api.servers.action(dn, action, pkg);
      setNotice(
        `Queued for ${result.node}. It runs at the machine's next check-in, or immediately with odm-agent apply --force on it.`,
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

  if (tab === "software") {
    return (
      <>
        {notice && <p className="muted">{notice}</p>}
        <div className="page-header">
          <h3 className="section-title">
            {facts.packages.length} installed by request, of {facts.package_count} in total
          </h3>
          <span className="spacer" />
          <button type="button" className="primary" onClick={() => setInstalling(true)}>
            Install a package
          </button>
        </div>

        <table className="data">
          <thead>
            <tr>
              <th scope="col">Package</th>
              <th scope="col">Version</th>
              <th scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {facts.packages.map((entry) => (
              <tr key={entry.name}>
                <td>{entry.name}</td>
                <td className="mono">{entry.version}</td>
                <td>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => setRemoving(entry.name)}
                  >
                    Uninstall
                  </button>
                </td>
              </tr>
            ))}
            {facts.packages.length === 0 && (
              <tr>
                <td colSpan={3} className="empty">
                  Nothing reported yet. The machine sends this on its next check-in.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {installing && (
          <InstallPackageDialog
            onClose={() => setInstalling(false)}
            onInstall={(name) => {
              setInstalling(false);
              void ask("package-install", name);
            }}
          />
        )}

        {removing && (
          <Modal
            title={`Uninstall ${removing}?`}
            submitLabel="Uninstall"
            onClose={() => setRemoving(null)}
            onSubmit={() => {
              const name = removing;
              setRemoving(null);
              void ask("package-remove", name);
            }}
          >
            <p>
              <strong>{removing}</strong> is removed from {facts.hostname}. Its configuration files
              are left in place.
            </p>
            <p className="muted">
              Packages that depend on it go with it, as apt decides. Nothing that keeps this machine
              joined and managed can be removed from here.
            </p>
          </Modal>
        )}
      </>
    );
  }

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
                <td>
                  {session.user}
                  <span className="badge">{session.source}</span>
                </td>
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

      <LocalAdministratorPanel dn={dn} />

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
      {facts.updates.length > 0 && <p className="mono muted">{facts.updates.join(", ")}</p>}
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

      <h3 className="section-title">This machine</h3>
      <div className="actions-row">
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void ask("policy-refresh")}
        >
          Re-apply policy
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => setPower("restart")}>
          <Power size={15} aria-hidden="true" />
          Restart
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => setPower("shutdown")}
        >
          Shut down
        </button>
      </div>

      {power && (
        <Modal
          title={power === "restart" ? "Restart this machine?" : "Shut this machine down?"}
          submitLabel={power === "restart" ? "Restart" : "Shut down"}
          onClose={() => setPower(null)}
          onSubmit={() => {
            const action = power;
            setPower(null);
            void ask(action);
          }}
        >
          <p>
            {facts.hostname} {power === "restart" ? "restarts" : "shuts down"} a minute after its
            agent picks this up. Anyone signed in loses their session.
          </p>
          {facts.sessions.length > 0 && (
            <p className="alert" role="alert">
              {facts.sessions.length} signed in right now:{" "}
              {facts.sessions.map((session) => session.user).join(", ")}
            </p>
          )}
          {power === "shutdown" && (
            <p className="muted">A machine that is off cannot be started again from here.</p>
          )}
        </Modal>
      )}

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

function InstallPackageDialog({
  onClose,
  onInstall,
}: {
  onClose: () => void;
  onInstall: (name: string) => void;
}) {
  const [name, setName] = useState("");

  return (
    <Modal
      title="Install a package"
      submitLabel="Install"
      onClose={onClose}
      onSubmit={() => name.trim() && onInstall(name.trim())}
    >
      <Field label="Package" hint="As apt names it, for example curl">
        <input value={name} required autoFocus onChange={(e) => setName(e.target.value)} />
      </Field>
      <p className="muted">
        Installed without recommended packages, from the sources the machine already has.
      </p>
    </Modal>
  );
}

/**
 * The machine's recent journal, collapsed by the unit that produced it.
 *
 * Groups with errors open by default and the rest stay shut: a page that
 * expands two hundred lines answers nothing, and the counts are what decide
 * which group is worth opening.
 */
function LogsTab({ dn }: { dn: string }) {
  const [hours, setHours] = useState(24);
  const [groups, setGroups] = useState<LogGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.servers.logs(dn, hours);
      setGroups(result.groups);
      setTotal(result.total);
      setOpen(new Set(result.groups.filter((group) => group.errors > 0).map((g) => g.unit)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [dn, hours]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(unit: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(unit)) next.delete(unit);
      else next.add(unit);
      return next;
    });
  }

  return (
    <>
      <div className="page-header">
        <h3 className="section-title">
          {total} {total === 1 ? "entry" : "entries"}
        </h3>
        <span className="spacer" />
        <select
          aria-label="How far back"
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
        >
          <option value={6}>Last 6 hours</option>
          <option value={24}>Last 24 hours</option>
          <option value={72}>Last 3 days</option>
          <option value={336}>Last 14 days</option>
        </select>
        <button type="button" className="ghost" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <ul className="log-groups">
        {groups.map((group) => (
          <li key={group.unit}>
            <button type="button" className="log-group" onClick={() => toggle(group.unit)}>
              {open.has(group.unit) ? (
                <ChevronDown size={15} aria-hidden="true" />
              ) : (
                <ChevronRight size={15} aria-hidden="true" />
              )}
              <span className="unit">{group.unit}</span>
              <span className="count">{group.count}</span>
              {group.errors > 0 && (
                <span className="badge failure">
                  {group.errors} {group.errors === 1 ? "error" : "errors"}
                </span>
              )}
            </button>
            {open.has(group.unit) && (
              <table className="data compact">
                <tbody>
                  {group.entries.map((entry, index) => (
                    <tr key={index}>
                      <td style={{ width: "170px" }}>
                        {new Date(entry.occurred_at).toLocaleString()}
                      </td>
                      <td style={{ width: "70px" }}>
                        {entry.priority <= 3 ? (
                          <span className="badge failure">error</span>
                        ) : (
                          <span className="badge">warn</span>
                        )}
                      </td>
                      <td className="mono">{entry.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
        {!loading && groups.length === 0 && (
          <li className="empty">
            Nothing at warning level or worse. The agent sends these on its check-in.
          </li>
        )}
      </ul>
    </>
  );
}
