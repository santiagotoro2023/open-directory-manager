import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, FolderLock, KeyRound, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { ApiError, api, type PasswordManagerStatus, type VaultCollection } from "../api";
import { InfoPanel } from "../components/DocsLink";
import { Loading } from "../components/Loading";
import { Field, Modal } from "../components/Modal";
import { PickerField } from "../components/Picker";

type Tab = "seats" | "collections";

/**
 * The password manager, managed here and nowhere else.
 *
 * The console owns the vault's organisation through an account of its
 * own, so everything an administrator decides is decided on this page:
 * who has a seat (domain groups and accounts), which collections exist,
 * and which groups see each one. The vault itself — the extension, the
 * app, or its own tab from the button up top — is for using passwords,
 * not administering them. (It is not shown in a frame here: the web
 * vault's unlock does not work inside one.)
 */
export function Passwords() {
  const [tab, setTab] = useState<Tab>("seats");
  const [status, setStatus] = useState<PasswordManagerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  const [seats, setSeatsState] = useState({ groups: "", users: "" });
  const [setup, setSetup] = useState({ groups: "", users: "", password: "" });
  const [newCollection, setNewCollection] = useState<string | null>(null);
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [grant, setGrant] = useState<{ id: string; group: string; readOnly: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<VaultCollection | null>(null);

  const setSeats = useCallback((next: typeof seats) => {
    dirty.current = true;
    setSeatsState(next);
  }, []);

  const apply = useCallback((result: PasswordManagerStatus) => {
    setStatus(result);
    if (!dirty.current) {
      setSeatsState({
        groups: result.seat_groups.map((g) => `%${g}`).join(", "),
        users: result.seat_users.join(", "),
      });
    }
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api.passwords.status());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [apply]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  function split(text: string): string[] {
    return text
      .split(",")
      .map((part) => part.trim().replace(/^%/, ""))
      .filter(Boolean);
  }

  async function run(work: () => Promise<PasswordManagerStatus | void>, done?: string) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await work();
      if (result) apply(result);
      else await load();
      if (done) setNotice(done);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!status && !error) {
    return (
      <div className="content">
        <Loading />
      </div>
    );
  }

  const usable = Boolean(status?.installed && status.ca_ready);
  const vaultHere = "/vault/";

  return (
    <div className="content">
      <div className="page-header">
        <h1>
          <KeyRound size={20} aria-hidden="true" /> Passwords
        </h1>
        <span className="spacer" />
        {status?.ready && (
          <>
            <button
              type="button"
              className="ghost"
              onClick={() => window.open(vaultHere, "_blank", "noopener")}
            >
              <ExternalLink size={15} aria-hidden="true" />
              Open the vault
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.passwords.apply();
                })
              }
            >
              <RefreshCw size={15} aria-hidden="true" />
              Apply now
            </button>
          </>
        )}
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}

      {status && !status.installed && (
        <>
          <InfoPanel page="password-manager">
            Vaultwarden, the open-source Bitwarden server, run and managed by ODM. Seats,
            collections and who sees them are decided on this page; people sign in with their
            domain account and use the vault, never administer it.
          </InfoPanel>
          <div className="detail-card">
            <h3 className="section-title">Two things first</h3>
            <ol className="wiki-steps">
              <li>
                {status.ca_ready ? (
                  <>A certificate authority — the domain has one.</>
                ) : (
                  <>
                    A certificate authority:{" "}
                    <Link to="/certificates">set one up under Certificates</Link>. The console
                    carries the vault&rsquo;s traffic over TLS it checks against it.
                  </>
                )}
              </li>
              <li>
                The password-manager role on a member server:{" "}
                <Link to="/roles">install it under Server Roles</Link>. Any member server; nobody
                connects to it directly — the vault is{" "}
                <span className="mono">{status.vault_url}</span>, on this console.
              </li>
            </ol>
          </div>
        </>
      )}

      {status && status.installed && !status.ready && (
        <>
          <InfoPanel page="password-manager">
            One press sets everything up: the vault gets its address and certificate, the console
            makes its own account in it and an organisation named after the domain, and from then
            on the seats and collections are kept in step by the console.
          </InfoPanel>
          {!usable && (
            <p className="alert" role="alert">
              The domain needs a certificate authority first —{" "}
              <Link to="/certificates">Certificates</Link>.
            </p>
          )}
          <div className="detail-card">
            <h3 className="section-title">Set up the vault</h3>
            <div className="field-grid">
              <label className="field">
                <span>Groups whose members get a seat</span>
                <PickerField
                  kind="group"
                  as="principal"
                  ariaLabel="Groups"
                  placeholder="%Sales, %Finance"
                  multiple
                  value={setup.groups}
                  onChange={(value) => setSetup({ ...setup, groups: value })}
                />
                <small>Nesting included. Changeable later, under Seats.</small>
              </label>
              <label className="field">
                <span>Accounts that get a seat besides</span>
                <PickerField
                  kind="user"
                  as="name"
                  ariaLabel="Accounts"
                  placeholder="ada, sam"
                  multiple
                  value={setup.users}
                  onChange={(value) => setSetup({ ...setup, users: value })}
                />
                <small>You get one regardless.</small>
              </label>
              <label className="field">
                <span>Your domain password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={setup.password}
                  onChange={(e) => setSetup({ ...setup, password: e.target.value })}
                />
                <small>
                  Optional. Given, your vault account&rsquo;s master password is set to it now, so
                  the vault opens with the password you already know. Left empty, you choose one at
                  your first sign-in. The console keeps neither.
                </small>
              </label>
            </div>
            <div className="actions-row">
              <button
                type="button"
                className="primary"
                disabled={busy || !usable}
                onClick={() =>
                  void run(async () => {
                    const answer = await api.passwords.setup({
                      seat_groups: split(setup.groups),
                      seat_users: split(setup.users),
                      my_password: setup.password,
                    });
                    setSetup({ ...setup, password: "" });
                    setNotice(answer.summary);
                    return answer;
                  })
                }
              >
                {busy ? "Setting up…" : "Set up the vault"}
              </button>
              {status.last_sync_result && <span className="muted">{status.last_sync_result}</span>}
            </div>
          </div>
        </>
      )}

      {status?.ready && (
        <>
          <p className="muted">
            Organisation <strong>{status.org_name}</strong> on{" "}
            <span className="mono">{status.node_fqdn}</span>, owned by the console&rsquo;s account{" "}
            <span className="mono">{status.owner_account}</span>.{" "}
            {status.last_sync_at
              ? `Last reconciled ${new Date(status.last_sync_at).toLocaleString()}: ${status.last_sync_result}`
              : "Not reconciled yet."}
            {status.sync_requested && " · a pass is due"}
          </p>

          <nav className="tabs" aria-label="Password manager views">
            {(["seats", "collections"] as Tab[]).map((current) => (
              <button
                key={current}
                type="button"
                className={tab === current ? "tab active" : "tab"}
                aria-current={tab === current ? "true" : undefined}
                onClick={() => setTab(current)}
              >
                {current === "seats" ? "Seats" : "Collections"}
              </button>
            ))}
          </nav>

          {tab === "seats" && (
            <>
              <InfoPanel page="password-manager">
                A seat is a vault account. The members of these groups and these accounts are
                invited; at their first sign-in (domain account, through the console) their vault
                is made and the console confirms them. Someone who leaves loses the seat at the
                next pass.
              </InfoPanel>
              <div className="detail-card">
                <div className="field-grid">
                  <label className="field">
                    <span>Groups whose members get a seat</span>
                    <PickerField
                      kind="group"
                      as="principal"
                      ariaLabel="Groups"
                      placeholder="%Sales, %Finance"
                      multiple
                      value={seats.groups}
                      onChange={(value) => setSeats({ ...seats, groups: value })}
                    />
                  </label>
                  <label className="field">
                    <span>Accounts that get a seat besides</span>
                    <PickerField
                      kind="user"
                      as="name"
                      ariaLabel="Accounts"
                      placeholder="ada, sam"
                      multiple
                      value={seats.users}
                      onChange={(value) => setSeats({ ...seats, users: value })}
                    />
                  </label>
                </div>
                <div className="actions-row">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await api.passwords.seats({
                          seat_groups: split(seats.groups),
                          seat_users: split(seats.users),
                        });
                        dirty.current = false;
                        return result;
                      }, "Saved; the vault is brought in step within a few seconds.")
                    }
                  >
                    Save seats
                  </button>
                </div>
              </div>

              <h3 className="section-title">
                <Users size={15} aria-hidden="true" /> People with a seat
              </h3>
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Address</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {status.members.map((member) => (
                    <tr key={member.email}>
                      <td className="nowrap">{member.name || "—"}</td>
                      <td className="mono">{member.email}</td>
                      <td className="nowrap">
                        <span
                          className={`badge ${member.status === "confirmed" ? "success" : member.status === "revoked" ? "failure" : ""}`}
                        >
                          {member.status === "invited"
                            ? "invited — has not signed in yet"
                            : member.status === "accepted"
                              ? "signed in — being confirmed"
                              : member.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {status.members.length === 0 && (
                    <tr>
                      <td colSpan={3} className="empty">
                        Nobody yet — save seats above, or wait for the next pass.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}

          {tab === "collections" && (
            <>
              <InfoPanel page="password-manager">
                A collection is a folder of shared passwords. Give it to domain groups: their
                members see it in the vault, and may add to it unless read-only. The console makes
                the collection and the groups in the vault and keeps them in step.
              </InfoPanel>
              <div className="actions-row">
                <button type="button" className="primary" onClick={() => setNewCollection("")}>
                  <Plus size={15} aria-hidden="true" />
                  New collection
                </button>
              </div>
              {status.collections.map((collection) => (
                <div className="detail-card collection-card" key={collection.id}>
                  <div className="collection-head">
                    <h3 className="section-title">
                      <FolderLock size={15} aria-hidden="true" /> {collection.name}
                      {!collection.in_vault && <span className="badge">not in the vault yet</span>}
                    </h3>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setRename({ id: collection.id, name: collection.name })}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setGrant({ id: collection.id, group: "", readOnly: false })}
                    >
                      <Plus size={14} aria-hidden="true" />
                      Give to a group
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      aria-label={`Delete ${collection.name}`}
                      onClick={() => setConfirmDelete(collection)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                  {collection.access.length === 0 ? (
                    <p className="muted">Nobody sees this collection yet.</p>
                  ) : (
                    <table className="data">
                      <thead>
                        <tr>
                          <th scope="col">Group</th>
                          <th scope="col">May</th>
                          <th scope="col" />
                        </tr>
                      </thead>
                      <tbody>
                        {collection.access.map((entry) => (
                          <tr key={entry.group_name}>
                            <td className="nowrap">%{entry.group_name}</td>
                            <td className="wide">
                              <label className="checkbox">
                                <input
                                  type="checkbox"
                                  checked={!entry.read_only}
                                  disabled={busy}
                                  onChange={(e) =>
                                    void run(() =>
                                      api.passwords.collections.grant(
                                        collection.id,
                                        entry.group_name,
                                        !e.target.checked,
                                      ),
                                    )
                                  }
                                />
                                change and add passwords
                              </label>
                            </td>
                            <td className="nowrap">
                              <button
                                type="button"
                                className="ghost"
                                disabled={busy}
                                onClick={() =>
                                  void run(() =>
                                    api.passwords.collections.revoke(
                                      collection.id,
                                      entry.group_name,
                                    ),
                                  )
                                }
                              >
                                Take away
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
              {status.collections.length === 0 && <p className="muted">No collections yet.</p>}
            </>
          )}

        </>
      )}

      {newCollection !== null && (
        <Modal
          title="New collection"
          submitLabel="Create"
          onClose={() => setNewCollection(null)}
          onSubmit={() =>
            void run(async () => {
              const result = await api.passwords.collections.create(newCollection);
              setNewCollection(null);
              return result;
            })
          }
        >
          <Field label="Name" hint="A team or a purpose: Sales, Finance, Servers.">
            <input
              value={newCollection}
              autoFocus
              onChange={(e) => setNewCollection(e.target.value)}
            />
          </Field>
        </Modal>
      )}

      {rename && (
        <Modal
          title="Rename collection"
          submitLabel="Rename"
          onClose={() => setRename(null)}
          onSubmit={() =>
            void run(async () => {
              const result = await api.passwords.collections.rename(rename.id, rename.name);
              setRename(null);
              return result;
            })
          }
        >
          <Field label="Name">
            <input
              value={rename.name}
              autoFocus
              onChange={(e) => setRename({ ...rename, name: e.target.value })}
            />
          </Field>
        </Modal>
      )}

      {grant && (
        <Modal
          title="Give the collection to a group"
          submitLabel="Give"
          onClose={() => setGrant(null)}
          onSubmit={() =>
            void run(async () => {
              const result = await api.passwords.collections.grant(
                grant.id,
                grant.group.replace(/^%/, ""),
                grant.readOnly,
              );
              setGrant(null);
              return result;
            })
          }
        >
          <Field label="Group" hint="Its members see the collection in their vault.">
            <PickerField
              kind="group"
              as="principal"
              ariaLabel="Group"
              placeholder="%Sales"
              value={grant.group}
              onChange={(value) => setGrant({ ...grant, group: value })}
            />
          </Field>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={grant.readOnly}
              onChange={(e) => setGrant({ ...grant, readOnly: e.target.checked })}
            />
            Read-only: they may use the passwords but not change or add any
          </label>
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          title="Delete collection"
          submitLabel="Delete"
          onClose={() => setConfirmDelete(null)}
          onSubmit={() =>
            void run(async () => {
              const result = await api.passwords.collections.remove(confirmDelete.id);
              setConfirmDelete(null);
              return result;
            })
          }
        >
          <p>
            <strong>{confirmDelete.name}</strong> is removed from the vault with every password in
            it, for everyone. There is no recycle bin for this.
          </p>
        </Modal>
      )}
    </div>
  );
}
