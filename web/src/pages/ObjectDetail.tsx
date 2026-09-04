import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  Folder,
  KeyRound,
  Monitor,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
  Trash2,
  User,
  Users,
} from "lucide-react";
import {
  ApiError,
  api,
  type ComputerAction,
  type ComputerDetail,
  type DirectoryListing,
  type DirectoryObject,
  type LogGroup,
  type NewLocalUser,
} from "../api";
import { LoadingRow } from "../components/Loading";
import { PickerField } from "../components/Picker";
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
  PhotoDialog,
  isDisabled,
  text,
} from "../components/objectDialogs";
import { MembershipTable } from "../components/Membership";
import Select from "../components/Select";

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
  | "general"
  | "members"
  | "memberof"
  | "policy"
  | "machine"
  | "software"
  | "users"
  | "files"
  | "activity"
  | "shell"
  | "logs";

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
  const [tab, setTab] = useState<Tab>("general");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<
    "password" | "photo" | "move" | "members" | "delete" | "rsop" | null
  >(
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
  // What the machine answers to. The agent is keyed by its DNS host name; the
  // common name is the fallback for one that has never reported.
  const machineName = String(object.dNSHostName ?? object.cn ?? object.name ?? "");
  const Icon = ICONS[object.objectType as keyof typeof ICONS] ?? Folder;

  // Both directions, for every kind of object. A group is a member of groups
  // exactly as a user is, and that half decided what a rule written against
  // one group actually reaches — with nowhere in the console to see it.
  const tabs: { id: Tab; label: string }[] = [
    { id: "general", label: "General" },
    ...(object.objectType === "group" ? [{ id: "members" as Tab, label: "Members" }] : []),
    ...(object.objectType === "ou" ? [] : [{ id: "memberof" as Tab, label: "Member of" }]),
    { id: "policy", label: "Policy" },
    ...(isComputer
      ? [
          { id: "machine" as Tab, label: "Machine" },
          { id: "software" as Tab, label: "Software" },
          { id: "users" as Tab, label: "Local users" },
          { id: "files" as Tab, label: "Files" },
          { id: "shell" as Tab, label: "Shell" },
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
              <Select
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
              </Select>
            </>
          )}

          <h3 className="section-title">Actions</h3>
          <div className="actions-row">
            {object.objectType === "user" && (
              <button type="button" className="ghost" onClick={() => setDialog("password")}>
                Reset password
              </button>
            )}
            {object.objectType === "user" && (
              <button type="button" className="ghost" onClick={() => setDialog("photo")}>
                Picture
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

      {tab === "members" && <MembersTab object={object} onChanged={() => void load()} />}

      {tab === "memberof" && <MembershipTable dn={dn} direction="up" />}

      {tab === "policy" && (
        <RsopDialog
          dn={dn}
          isComputer={isComputer}
          account={object.objectType === "user" ? text(object.sAMAccountName) : undefined}
          onClose={() => setTab("general")}
          inline
        />
      )}

      {isComputer &&
        (tab === "machine" || tab === "software" || tab === "users" || tab === "activity") && (
          <ComputerTabs dn={dn} tab={tab} />
        )}

      {isComputer && tab === "files" && <FilesTab hostname={machineName} />}

      {isComputer && tab === "shell" && <ShellTab dn={dn} hostname={machineName} />}
      {isComputer && tab === "logs" && <LogsTab dn={dn} />}

      {dialog === "password" && <PasswordDialog dn={dn} onClose={() => setDialog(null)} />}
      {dialog === "photo" && (
        <PhotoDialog dn={dn} onClose={() => setDialog(null)} onSaved={() => void load()} />
      )}
      {dialog === "move" && (
        <MoveDialog
          object={object}
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

function MembersTab({ object, onChanged }: { object: DirectoryObject; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  // Remounts the table after an edit, so the list is what the directory holds
  // rather than what it held when the tab opened.
  const [revision, setRevision] = useState(0);

  return (
    <>
      <div className="actions-row">
        <button type="button" className="primary" onClick={() => setEditing(true)}>
          Edit members
        </button>
      </div>

      <MembershipTable
        key={revision}
        dn={String(object.distinguishedName)}
        direction="down"
      />

      {editing && (
        <MembersDialog
          group={object}
          onClose={() => setEditing(false)}
          onChanged={() => {
            setEditing(false);
            setRevision((was) => was + 1);
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
  const [addingUser, setAddingUser] = useState(false);
  const [removingUser, setRemovingUser] = useState<string | null>(null);

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

  async function ask(action: ComputerAction, pkg?: string, localUser?: NewLocalUser) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api.servers.action(dn, action, pkg, localUser);
      setNotice(
        `Sent to ${result.node}. Its agent picks this up within a second unless the machine is off.`,
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
      <>
        <div className="page-header">
          <h3 className="section-title">Accounts on this machine only</h3>
          <span className="spacer" />
          <button type="button" className="primary" disabled={busy} onClick={() => setAddingUser(true)}>
            <Plus size={15} aria-hidden="true" />
            New local account
          </button>
        </div>
        {notice && <p className="muted">{notice}</p>}
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">UID</th>
              <th scope="col">Groups</th>
              <th scope="col">Shell</th>
              <th scope="col" className="actions" />
            </tr>
          </thead>
          <tbody>
            {facts.local_users.map((user) => (
              <tr key={user.name}>
                <td>{user.name}</td>
                <td>{user.uid}</td>
                <td>{user.groups.join(", ") || "—"}</td>
                <td className="mono">{user.shell}</td>
                <td className="actions">
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    aria-label={`Delete ${user.name}`}
                    onClick={() => setRemovingUser(user.name)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
            {facts.local_users.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No local accounts outside the system range.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {addingUser && (
          <LocalUserDialog
            onClose={() => setAddingUser(false)}
            onSubmit={async (account) => {
              setAddingUser(false);
              await ask("local-user-add", undefined, account);
            }}
          />
        )}

        {removingUser && (
          <Modal
            title={`Delete ${removingUser}`}
            submitLabel="Delete"
            onClose={() => setRemovingUser(null)}
            onSubmit={async () => {
              const account = removingUser;
              setRemovingUser(null);
              await ask("local-user-remove", undefined, { name: account });
            }}
          >
            <p>
              Removes the account and its home directory from this machine. Nothing in the directory
              changes, and system accounts cannot be removed from here.
            </p>
          </Modal>
        )}
      </>
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
                  {session.source && <span className="badge">{session.source}</span>}
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

      <h3 className="section-title">Agent</h3>
      <dl className="definition">
        <dt>Installed</dt>
        <dd className="mono">
          {detail.agent.installed || "not reported yet"}
          {detail.agent.behind && <span className="badge"> behind</span>}
        </dd>
        <dt>Available</dt>
        <dd className="mono">{detail.agent.available || "this console has none to hand out"}</dd>
      </dl>
      <div className="actions-row">
        <button
          type="button"
          className={detail.agent.behind ? "primary" : "ghost"}
          disabled={busy || !detail.agent.available}
          onClick={() => void ask("agent-update")}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {detail.agent.behind ? `Update to ${detail.agent.available}` : "Reinstall the agent"}
        </button>
      </div>

      <LocalAdministratorPanel dn={dn} />

      <h3 className="section-title">This machine</h3>
      <div className="actions-row">
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void ask("policy-refresh")}
        >
          <RefreshCw size={15} aria-hidden="true" />
          Re-apply policy
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => setPower("restart")}>
          <Power size={15} aria-hidden="true" />
          Restart
        </button>
        <span className="spacer" />
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
              <td>
                <TaskOutput text={task.output ?? ""} />
              </td>
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

/**
 * What a task printed, in the space a table row has for it.
 *
 * Some of these are a machine's whole directory listing in JSON. Rendered as
 * it arrived, one browse pushed everything else off the page.
 */
function TaskOutput({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  if (!trimmed) return <span className="muted">—</span>;

  const long = trimmed.length > 160 || trimmed.includes("\n");
  if (!long) return <span className="mono">{trimmed}</span>;

  return (
    <>
      <button type="button" className="button-link" onClick={() => setOpen((was) => !was)}>
        {open ? "Hide" : `Show ${trimmed.length.toLocaleString()} characters`}
      </button>
      {open && <pre className="command-output">{trimmed}</pre>}
      {!open && <p className="mono muted task-preview">{trimmed.slice(0, 120)}…</p>}
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
/**
 * A shell on the machine, for troubleshooting it from here.
 *
 * Not a terminal — there is no pty, so no job control, no curses program and
 * nothing that stops to ask a question. What it does keep is the working
 * directory, so cd carries from one command to the next, and what somebody
 * has typed, so the arrow keys walk it. Everything else starts fresh: a
 * variable exported in one command is gone in the next.
 *
 * This is root on that machine. It is its own right rather than something
 * that comes with reading a computer, and every command is in the audit log
 * with who ran it and what came back.
 */
function ShellTab({ dn, hostname }: { dn: string; hostname: string }) {
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("/");
  const [lines, setLines] = useState<
    { command: string; cwd: string; output: string; failed: string }[]
  >([]);
  // Every command typed, newest last, whether or not it worked — the arrow
  // keys walk this rather than the transcript, so clearing the screen does
  // not lose what was typed before it.
  const [typed, setTyped] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [recalled, setRecalled] = useState<number | null>(null);
  const transcript = useRef<HTMLDivElement | null>(null);

  // A terminal scrolls to what just happened.
  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [lines]);

  async function run() {
    const entry = command.trim();
    if (!entry || busy) return;
    setCommand("");
    setRecalled(null);
    setTyped((was) => (was[was.length - 1] === entry ? was : [...was, entry]));

    // Handled here rather than sent: clear empties this screen, and the
    // machine's own clear would send terminal escapes nothing here reads.
    if (entry === "clear") {
      setLines([]);
      return;
    }

    setBusy(true);
    const at = cwd;
    try {
      const result = await api.servers.shell(dn, entry, cwd);
      setCwd(result.cwd || cwd);
      setLines((was) => [
        ...was,
        { command: entry, cwd: at, output: result.output, failed: result.failed },
      ]);
    } catch (err) {
      setLines((was) => [
        ...was,
        {
          command: entry,
          cwd: at,
          output: "",
          failed: err instanceof ApiError ? err.message : String(err),
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  function keys(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      void run();
      return;
    }
    // Ctrl-L, where a terminal puts it.
    if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      setLines([]);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (typed.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "ArrowUp"
        ? Math.max(0, (recalled ?? typed.length) - 1)
        : Math.min(typed.length, (recalled ?? typed.length) + 1);
    setRecalled(next);
    setCommand(next >= typed.length ? "" : typed[next]);
  }

  const prompt = `root@${hostname.split(".")[0]}:${cwd}#`;

  return (
    <>
      <p className="muted">
        Each command runs as root on this machine and finishes before the next one starts.{" "}
        <code>cd</code> carries over; nothing else does. <code>clear</code> empties this screen.
        Every command is recorded in the audit log.
      </p>

      <div className="command-output shell-transcript" role="log" ref={transcript}>
        {lines.map((line, index) => (
          <div key={index}>
            <p className="mono shell-prompt">
              <strong>
                root@{hostname.split(".")[0]}:{line.cwd}#
              </strong>{" "}
              {line.command}
            </p>
            {line.output && <pre>{line.output}</pre>}
            {line.failed && <pre className="alert">{line.failed}</pre>}
          </div>
        ))}
        {lines.length === 0 && <p className="muted">Nothing run yet.</p>}
      </div>

      <div className="picker-field">
        <span className="mono shell-prompt" aria-hidden="true">
          {prompt}
        </span>
        <input
          aria-label={`Command on ${hostname}`}
          className="mono"
          placeholder="journalctl -u odm-agent -n 50"
          value={command}
          disabled={busy}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={keys}
        />
        <button
          type="button"
          className="primary"
          disabled={busy || !command.trim()}
          onClick={() => void run()}
        >
          {busy ? "Running…" : "Run"}
        </button>
      </div>
    </>
  );
}

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
        <Select
          aria-label="How far back"
          value={String(hours)}
          onChange={(e) => setHours(Number(e.target.value))}
        >
          <option value={6}>Last 6 hours</option>
          <option value={24}>Last 24 hours</option>
          <option value={72}>Last 3 days</option>
          <option value={336}>Last 14 days</option>
        </Select>
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

/** A local account on one machine — a service login, a break-glass account. */
function LocalUserDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (account: NewLocalUser) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [fullName, setFullName] = useState("");
  const [shell, setShell] = useState("/bin/bash");
  const [groups, setGroups] = useState("");
  const [password, setPassword] = useState("");

  return (
    <Modal
      title="New local account"
      submitLabel="Create"
      onClose={onClose}
      onSubmit={() =>
        onSubmit({
          name,
          full_name: fullName,
          shell,
          groups: groups
            .split(/[\s,]+/)
            .map((one) => one.trim())
            .filter(Boolean),
          password,
        })
      }
    >
      <p className="muted">
        This account exists on this machine alone. For an account that works across the domain,
        create a user in the directory instead.
      </p>
      <Field label="Login name" hint="Lower case, no spaces">
        <input value={name} required onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Full name">
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
      </Field>
      <Field label="Shell">
        <Select value={shell} onChange={(e) => setShell(e.target.value)}>
          <option value="/bin/bash">/bin/bash</option>
          <option value="/bin/sh">/bin/sh</option>
          <option value="/usr/sbin/nologin">/usr/sbin/nologin — no interactive login</option>
        </Select>
      </Field>
      <Field label="Groups" hint="Comma separated. sudo grants administrative rights here.">
        <input value={groups} onChange={(e) => setGroups(e.target.value)} />
      </Field>
      <Field label="Password" hint="Leave empty to create it with password login locked">
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

/** What is on the machine's own disk, read through its agent.
 *
 * Names, sizes and times; the console never asks for a file's contents. The
 * same listing the share dialog browses with, with the files shown. */
function FilesTab({ hostname }: { hostname: string }) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [path, setPath] = useState("/");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DirectoryListing["entries"][number] | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    api.servers
      .browse(hostname, path, false, true)
      .then((result) => current && setListing(result))
      .catch((err) => current && setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [hostname, path]);

  return (
    <>
      <div className="page-header">
        <h3 className="section-title">Files on {hostname}</h3>
        <span className="spacer" />
        {listing?.parent !== undefined && listing?.parent !== null && path !== "/" && (
          <button type="button" className="ghost" onClick={() => setPath(listing.parent as string)}>
            <ChevronUp size={15} aria-hidden="true" />
            Up
          </button>
        )}
        <button type="button" className="ghost" onClick={() => setPath("/")}>
          Top
        </button>
      </div>

      <p className="mono muted">{path}</p>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <table className="data">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" style={{ width: "110px" }}>
              Size
            </th>
            <th scope="col" style={{ width: "160px" }}>
              Owner
            </th>
            <th scope="col" style={{ width: "140px" }}>
              Group
            </th>
            <th scope="col" style={{ width: "80px" }}>
              Mode
            </th>
            <th scope="col" style={{ width: "180px" }}>
              Changed
            </th>
            <th scope="col" style={{ width: "110px" }}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(listing?.entries ?? []).map((entry) => (
            <tr
              key={entry.path}
              onClick={() => entry.directory && setPath(entry.path)}
              style={entry.directory ? { cursor: "pointer" } : undefined}
            >
              <td>
                {entry.directory ? (
                  <Folder size={15} aria-hidden="true" />
                ) : (
                  <FileText size={15} aria-hidden="true" />
                )}
                {entry.name}
              </td>
              <td className="mono">{entry.directory ? "—" : size(entry.size ?? 0)}</td>
              <td className="mono">{entry.owner ?? "—"}</td>
              <td className="mono">{entry.group ?? "—"}</td>
              <td className="mono">{entry.mode ?? "—"}</td>
              <td>{entry.modified ? new Date(entry.modified).toLocaleString() : "—"}</td>
              <td>
                <button
                  type="button"
                  className="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditing(entry);
                  }}
                >
                  Permissions…
                </button>
              </td>
            </tr>
          ))}
          {loading ? (
            <LoadingRow colSpan={7} />
          ) : (
            (listing?.entries ?? []).length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  Nothing in this directory.
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>

      {listing?.truncated && <p className="muted">Only the first 500 entries are listed.</p>}

      {editing && (
        <PermissionsDialog
          hostname={hostname}
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={(result) => {
            setEditing(null);
            setListing(result);
          }}
        />
      )}
    </>
  );
}

/**
 * Who a file or folder belongs to, and what they may do with it.
 *
 * Owner, group and mode — the three things a POSIX file has. An access
 * control list is not editable here on purpose: a share's list is the share's,
 * managed under File Shares where it applies to everything inside it, and two
 * places to set one thing is how they end up disagreeing.
 */
function PermissionsDialog({
  hostname,
  entry,
  onClose,
  onSaved,
}: {
  hostname: string;
  entry: DirectoryListing["entries"][number];
  onClose: () => void;
  onSaved: (listing: DirectoryListing) => void;
}) {
  const [owner, setOwner] = useState(entry.owner ?? "");
  const [group, setGroup] = useState(entry.group ?? "");
  const [mode, setMode] = useState(entry.mode ?? "");
  const [recursive, setRecursive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed =
    owner !== (entry.owner ?? "") || group !== (entry.group ?? "") || mode !== (entry.mode ?? "");

  return (
    <Modal
      title={entry.name}
      submitLabel={busy ? "Applying…" : "Apply"}
      onClose={onClose}
      onSubmit={async () => {
        if (!changed || busy) return;
        setBusy(true);
        setError(null);
        try {
          onSaved(
            await api.servers.setPermissions({
              node: hostname,
              path: entry.path,
              owner: owner !== (entry.owner ?? "") ? owner : "",
              group: group !== (entry.group ?? "") ? group : "",
              mode: mode !== (entry.mode ?? "") ? mode : "",
              recursive,
            }),
          );
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
          setBusy(false);
        }
      }}
    >
      <p className="mono muted">{entry.path}</p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="field-grid">
        <Field label="Owner" hint="A domain or local account on that machine">
          {/* The account name, not a sudoers principal: this reaches chown,
              which takes a name and not a leading %. */}
          <PickerField
            kind="user"
            as="name"
            local
            ariaLabel="Owner"
            value={owner}
            onChange={setOwner}
          />
        </Field>
        <Field label="Group">
          <PickerField
            kind="group"
            as="name"
            ariaLabel="Group"
            value={group}
            onChange={setGroup}
          />
        </Field>
        <Field label="Mode" hint="Octal, as chmod takes it: 0750">
          <input
            className="mono"
            value={mode}
            placeholder="0750"
            pattern="0?[0-7]{3}"
            onChange={(event) => setMode(event.target.value)}
          />
        </Field>
      </div>
      {entry.directory && (
        <Field label="">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(event) => setRecursive(event.target.checked)}
            />
            Apply to everything inside it as well
          </label>
        </Field>
      )}
    </Modal>
  );
}

/** A file size somebody reads rather than counts. */
function size(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
