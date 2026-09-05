import { useCallback, useEffect, useState } from "react";
import { Download, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ApiError, api, type ProfileDisk, type RdCollection, type RdSession } from "../api";
import { LoadingRow } from "../components/Loading";
import { InfoPanel } from "../components/DocsLink";
import { ChoiceList } from "../components/ChoiceList";
import { Field, Modal } from "../components/Modal";
import { Wizard } from "../components/Wizard";
import { PickerDialog, PickerField } from "../components/Picker";
import { useContextMenu } from "../components/ContextMenu";
import { SharePicker } from "../components/ResourcePicker";
import Select from "../components/Select"

type Tab = "broker" | "hosts" | "sessions" | "profiles";

const STATE_BADGE: Record<string, string> = {
  active: "success",
  failed: "failure",
  applying: "",
  pending: "",
};

/**
 * Remote desktop, in the shape an administrator already knows.
 *
 * A collection is a set of session hosts serving the same thing to the same
 * people, fronted by a broker. Everything that is a decision is made here, on
 * the broker's side, because it is made once for everybody; the Session hosts
 * tab is only which machines serve which collection.
 */
export function RemoteDesktop() {
  const [tab, setTab] = useState<Tab>("broker");
  const [collections, setCollections] = useState<RdCollection[]>([]);
  const [unassigned, setUnassigned] = useState<string[]>([]);
  const [sessions, setSessions] = useState<RdSession[]>([]);
  const [editing, setEditing] = useState<RdCollection | "new" | null>(null);
  const [connectFor, setConnectFor] = useState<RdCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const { bind, menu } = useContextMenu();

  /** Stop or resume sending new sessions to one host.
   *
   * Drained rather than removed: removing it would send everybody still on it
   * somewhere else at their next reconnect, which is what draining exists to
   * avoid. */
  async function drain(collection: RdCollection, host: string, accepts: boolean) {
    setError(null);
    try {
      const result = await api.rd.drain(collection.id, host, accepts);
      setNotice(
        accepts
          ? `${host} is taking new sessions again.`
          : `${host} is draining. ${result.sessions} session(s) still on it; it can be patched once they are gone.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.rd.list();
      setCollections(result.collections);
      setUnassigned(result.unassigned_hosts);
      if (tab === "sessions") setSessions((await api.rd.sessions()).sessions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="content">
      {menu}
      <div className="page-header">
        <h1>Remote Desktop</h1>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
          Refresh
        </button>
        <button type="button" className="primary" onClick={() => setEditing("new")}>
          <Plus size={15} aria-hidden="true" />
          New collection
        </button>
      </div>

      <InfoPanel page="remote-desktop">
        Session hosts run the desktops; a collection decides who reaches which of them. What a session may carry between client and host is a policy setting.
      </InfoPanel>

      <nav className="tabs" aria-label="Remote desktop views">
        {(
          [
            ["broker", "Broker"],
            ["hosts", "Session hosts"],
            ["sessions", "Sessions"],
            ["profiles", "Profile disks"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "tab active" : "tab"}
            aria-current={tab === id ? "true" : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}

      {tab === "broker" && (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Collection</th>
              <th scope="col">Broker</th>
              <th scope="col">Serves</th>
              <th scope="col">Hosts</th>
              <th scope="col" style={{ width: "110px" }}>
                State
              </th>
              <th scope="col" style={{ width: "170px" }}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {collections.map((collection) => (
              <tr key={collection.id} onClick={() => setEditing(collection)}>
                <td>{collection.name}</td>
                <td className="mono">
                  {collection.connection_address}
                  {collection.broker_secondary_fqdn && (
                    <span className="muted"> + standby</span>
                  )}
                </td>
                <td>
                  {collection.kind === "remoteapp"
                    ? `${collection.app_name || collection.app_path}`
                    : "Full desktop"}
                </td>
                <td>{collection.hosts.length || "none"}</td>
                <td>
                  <span className={`badge ${STATE_BADGE[collection.state] ?? ""}`}>
                    {collection.state}
                  </span>
                </td>
                <td onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="ghost"
                    disabled={collection.hosts.length === 0}
                    onClick={() => setConnectFor(collection)}
                  >
                    <Download size={15} aria-hidden="true" />
                    Connection file
                  </button>
                </td>
              </tr>
            ))}
            {loading ? (
              <LoadingRow colSpan={6} />
            ) : (
              collections.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No collections yet. A collection is what people connect to.
                </td>
              </tr>
            )
            )}
          </tbody>
        </table>
      )}

      {tab === "hosts" && (
        <>
          {collections.map((collection) => (
            <div key={collection.id}>
              <h3 className="section-title">{collection.name}</h3>
              <table className="data compact">
                <tbody>
                  {collection.host_state.map((host) => (
                    <tr
                      key={host.node_fqdn}
                      {...bind([
                        { label: host.node_fqdn, heading: true },
                        {
                          label: host.accepts_new
                            ? "Stop new sessions (drain)"
                            : "Take new sessions again",
                          onSelect: () => void drain(collection, host.node_fqdn, !host.accepts_new),
                        },
                        { separator: true },
                        {
                          label: `Remove from ${collection.name}`,
                          danger: true,
                          onSelect: async () => {
                            await api.rd
                              .removeHost(collection.id, host.node_fqdn)
                              .catch(() => undefined);
                            void load();
                          },
                        },
                      ])}
                    >
                      <td className="mono">{host.node_fqdn}</td>
                      <td style={{ width: "190px" }}>
                        {host.accepts_new ? (
                          <span className="badge success">Taking new sessions</span>
                        ) : (
                          <span className="badge">Draining</span>
                        )}
                      </td>
                      <td style={{ width: "150px" }}>
                        <button
                          type="button"
                          className="button-link"
                          onClick={() => void drain(collection, host.node_fqdn, !host.accepts_new)}
                        >
                          {host.accepts_new ? "Drain" : "Resume"}
                        </button>
                      </td>
                      <td style={{ width: "60px" }}>
                        <button
                          type="button"
                          className="icon"
                          aria-label={`Remove ${host.node_fqdn} from ${collection.name}`}
                          onClick={async () => {
                            await api.rd
                              .removeHost(collection.id, host.node_fqdn)
                              .catch(() => undefined);
                            void load();
                          }}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {collection.hosts.length === 0 && (
                    <tr>
                      <td className="empty">
                        No hosts. This collection serves nobody until it has one.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <AddHost collection={collection} onAdded={load} onError={setError} />
            </div>
          ))}

          <h3 className="section-title">Carrying the role, in no collection</h3>
          <table className="data compact">
            <tbody>
              {unassigned.map((host) => (
                <tr key={host}>
                  <td className="mono">{host}</td>
                </tr>
              ))}
              {unassigned.length === 0 && (
                <tr>
                  <td className="empty">Every session host is in a collection.</td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {tab === "profiles" && <ProfileDisks collections={collections} />}

      {tab === "sessions" && (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Host</th>
              <th scope="col">Display</th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((entry) => (
              <tr key={`${entry.node_fqdn}-${entry.username}`}>
                <td>{entry.username}</td>
                <td className="mono">{entry.node_fqdn}</td>
                <td className="mono">{entry.display || "—"}</td>
                <td>{new Date(entry.reported_at).toLocaleString()}</td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  Nobody is signed in, or no host has reported since they were.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {editing && (
        <CollectionDialog
          collection={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            void load();
          }}
        />
      )}

      {connectFor && (
        <ConnectionDialog collection={connectFor} onClose={() => setConnectFor(null)} />
      )}
    </main>
  );
}

function AddHost({
  collection,
  onAdded,
  onError,
}: {
  collection: RdCollection;
  onAdded: () => void;
  onError: (message: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="actions-row">
      <button type="button" className="ghost" onClick={() => setPicking(true)}>
        <Plus size={15} aria-hidden="true" />
        Add a session host
      </button>
      {picking && (
        <PickerDialog
          kind="computer"
          onClose={() => setPicking(false)}
          onPick={async (object) => {
            setPicking(false);
            try {
              await api.rd.addHost(
                collection.id,
                String(object.dNSHostName ?? object.cn ?? object.name),
              );
              onAdded();
            } catch (err) {
              onError(err instanceof ApiError ? err.message : String(err));
            }
          }}
        />
      )}
    </div>
  );
}

/** Everything about a collection, which is everything an administrator sets. */
function CollectionDialog({
  collection,
  onClose,
  onSaved,
}: {
  collection: RdCollection | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const editing = collection !== null;
  const [name, setName] = useState(collection?.name ?? "");
  const [description, setDescription] = useState(collection?.description ?? "");
  const [broker, setBroker] = useState(collection?.broker_fqdn ?? "");
  const [standby, setStandby] = useState(collection?.broker_secondary_fqdn ?? "");
  const [external, setExternal] = useState(collection?.external_fqdn ?? "");
  const [externalDns, setExternalDns] = useState(collection?.external_dns ?? true);
  const [kind, setKind] = useState<"desktop" | "remoteapp">(collection?.kind ?? "desktop");
  const [appPath, setAppPath] = useState(collection?.app_path ?? "");
  const [appName, setAppName] = useState(collection?.app_name ?? "");
  const [share, setShare] = useState(collection?.profile_share ?? "");
  const [profileGb, setProfileGb] = useState(collection?.profile_gb ?? 10);
  const [allowLocalHome, setAllowLocalHome] = useState(collection?.allow_local_home ?? false);
  const [idle, setIdle] = useState(collection?.idle_minutes ?? 60);
  const [disconnected, setDisconnected] = useState(collection?.disconnected_minutes ?? 120);
  const [maxSessions, setMaxSessions] = useState(collection?.max_sessions_per_host ?? 0);
  const [balance, setBalance] = useState<RdCollection["balance_method"]>(
    collection?.balance_method ?? "leastconn",
  );
  const [principals, setPrincipals] = useState<string[]>(collection?.principals ?? []);
  const [pickingShare, setPickingShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Wizard
      title={editing ? collection.name : "New collection"}
      submitLabel={editing ? "Save" : "Create"}
      busy={busy}
      error={error}
      onClose={onClose}
      steps={[
        {
          title: "Name and broker",
          hint: "People connect to the broker, which sends them to a session host in the collection.",
          incomplete: !name
            ? "Name the collection."
            : !broker
              ? "Choose the broker people connect to."
              : undefined,
          fields: (
            <>
              <div className="field-grid">
                <Field label="Name">
                  <input
                    value={name}
                    required
                    disabled={editing}
                    placeholder="Finance"
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field label="Broker" hint="The machine people connect to, never a host">
                  <PickerField
                    kind="computer"
                    as="host"
                    ariaLabel="Broker"
                    value={broker}
                    required
                    placeholder="rdbroker.corp.example.internal"
                    onChange={setBroker}
                  />
                </Field>
              </div>
              <Field label="Description">
                <input value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>
              <div className="field-grid">
                <Field
                  label="Standby broker"
                  hint="Optional. Carries the same routing, so either machine can front the collection."
                >
                  <PickerField
                    kind="computer"
                    as="host"
                    ariaLabel="Standby broker"
                    value={standby}
                    placeholder="No standby"
                    onChange={setStandby}
                  />
                </Field>
                <Field
                  label="Connect to"
                  hint="Optional. The name in everybody's connection file, instead of a broker's own."
                >
                  <input
                    value={external}
                    placeholder="remote.example.org"
                    onChange={(e) => setExternal(e.target.value)}
                  />
                </Field>
              </div>
              {external !== "" && (
                <Field label="This name is published">
                  <Select
                    value={externalDns ? "odm" : "elsewhere"}
                    onChange={(e) => setExternalDns(e.target.value === "odm")}
                  >
                    <option value="odm">
                      In this domain&rsquo;s DNS, by ODM &mdash; the zone is created if it is missing
                    </option>
                    <option value="elsewhere">Somewhere else &mdash; do not touch DNS</option>
                  </Select>
                </Field>
              )}
              {external !== "" && externalDns && (
                <p className="muted">
                  {external} is pointed at {standby ? "both brokers" : "the broker"}. A client that
                  cannot reach the first address tries the next, which is how an RDP client has
                  always found a second server &mdash; so replacing the machine behind the name
                  never touches anybody&rsquo;s connection file.
                </p>
              )}
            </>
          ),
        },
        {
          title: "What people get",
          hint: "A whole desktop, or one program with nothing around it.",
          incomplete:
            kind === "remoteapp" && !appPath ? "Give the path of the program to publish." : undefined,
          fields: (
            <>
              <Field label="Session">
                <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  <option value="desktop">A full desktop</option>
                  <option value="remoteapp">One published application</option>
                </Select>
              </Field>
              {kind === "remoteapp" && (
                <div className="field-grid">
                  <Field label="Program" hint="Absolute path on the session hosts">
                    <input
                      value={appPath}
                      required
                      placeholder="/usr/bin/libreoffice"
                      onChange={(e) => setAppPath(e.target.value)}
                    />
                  </Field>
                  <Field label="Shown as" hint="What the person sees in the connection file">
                    <input
                      value={appName}
                      placeholder="LibreOffice"
                      onChange={(e) => setAppName(e.target.value)}
                    />
                  </Field>
                </div>
              )}
            </>
          ),
        },
        {
          title: "Profiles",
          hint: "Where a person's settings and files live between sessions.",
          fields: (
            <>
              <p className="muted">
                Every person gets a disk on the share below, named for them, and it follows them to
                whichever host answers. Put <code>%username%</code> after the share to give each
                person their own directory, which is what keeps a collection's disks apart from a
                roaming-profile policy's. Leave the share empty and sessions use whatever home
                directory the host already gives them &mdash; right for a single session host, and
                wrong for a farm, where a profile that stays on one host is a different profile on
                every other one.
              </p>
              <div className="field-grid">
                <Field
                  label="Profile share"
                  hint="%username% becomes the person's own name, so one collection serves everybody"
                >
                  {/* Typeable, not only chosen: a farm's profile storage is
                      often somewhere the console has no file-server role on,
                      and that was a share nobody could enter. */}
                  <div className="picker-field">
                    <input
                      aria-label="Profile share"
                      placeholder="//fileserver.example.org/rds-profiles/%username%"
                      value={share}
                      onChange={(e) => setShare(e.target.value)}
                    />
                    <button type="button" className="ghost" onClick={() => setPickingShare(true)}>
                      Select…
                    </button>
                  </div>
                  {pickingShare && (
                    <SharePicker
                      onClose={() => setPickingShare(false)}
                      onPick={(picked) => {
                        setPickingShare(false);
                        setShare(picked.unc);
                      }}
                    />
                  )}
                </Field>
                <Field label="Each disk may grow to (GB)">
                  <input
                    type="number"
                    min={1}
                    max={2048}
                    value={profileGb}
                    onChange={(e) => setProfileGb(Number(e.target.value))}
                  />
                </Field>
              </div>
              <Field
                label="If the profile disk cannot be attached"
                hint="A local home exists on one host and nowhere else, so work saved to it is lost the next time somebody lands elsewhere"
              >
                <Select
                  value={allowLocalHome ? "local" : "refuse"}
                  onChange={(e) => setAllowLocalHome(e.target.value === "local")}
                >
                  <option value="refuse">Refuse the sign-in</option>
                  <option value="local">Sign in with a local home</option>
                </Select>
              </Field>
            </>
          ),
        },
        {
          title: "Sessions",
          hint: "How long a session outlives the person using it, and where a new one lands.",
          fields: (
            <>
              <div className="field-grid">
                <Field label="Sign out after idle (minutes)" hint="0 never">
                  <input
                    type="number"
                    min={0}
                    value={idle}
                    onChange={(e) => setIdle(Number(e.target.value))}
                  />
                </Field>
                <Field label="End disconnected after (minutes)" hint="0 never">
                  <input
                    type="number"
                    min={0}
                    value={disconnected}
                    onChange={(e) => setDisconnected(Number(e.target.value))}
                  />
                </Field>
                <Field label="Most sessions per host" hint="0 no limit">
                  <input
                    type="number"
                    min={0}
                    value={maxSessions}
                    onChange={(e) => setMaxSessions(Number(e.target.value))}
                  />
                </Field>
                <Field
                  label="Send a new session to"
                  hint="Someone reconnecting always returns to the host they were on"
                >
                  <Select
                    value={balance}
                    onChange={(e) => setBalance(e.target.value as RdCollection["balance_method"])}
                  >
                    <option value="leastconn">The host with the fewest sessions</option>
                    <option value="roundrobin">Each host in turn</option>
                    <option value="first">The first host with room, then the next</option>
                  </Select>
                </Field>
              </div>
              <p className="muted">
                This decides where somebody with no session yet lands. They can land on any host in
                the collection because their profile is a disk on the share, not files on one
                machine.
              </p>
            </>
          ),
        },
        {
          title: "Who may connect",
          hint: "The users and groups whose members may connect.",
          incomplete:
            principals.length === 0 ? "Add at least one user or group, or nobody can connect." : undefined,
          fields: (
            <ChoiceList
              kind="principal"
              values={principals}
              onChange={setPrincipals}
              addLabel="Add a user or group…"
              emptyLabel="Nobody yet. A collection with nobody on it serves nobody."
            />
          ),
        },
      ]}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        const body = {
          name,
          description,
          broker_fqdn: broker,
          broker_secondary_fqdn: standby,
          external_fqdn: external,
          external_dns: externalDns,
          kind,
          app_path: appPath,
          app_name: appName,
          profile_share: share,
          allow_local_home: allowLocalHome,
          profile_gb: profileGb,
          idle_minutes: idle,
          disconnected_minutes: disconnected,
          max_sessions_per_host: maxSessions,
          balance_method: balance,
          principals,
        };
        try {
          if (editing) {
            const saved = await api.rd.update({ id: collection.id, ...body });
            onSaved(
              [`Applying ${name} to its brokers and hosts.`, ...(saved.notes ?? [])].join(" "),
            );
          } else {
            const saved = await api.rd.create(body);
            onSaved(
              [`${name} created. Add session hosts to it.`, ...(saved.notes ?? [])].join(" "),
            );
          }
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
          setBusy(false);
        }
      }}
    />
  );
}

/** The .rdp file, for one person. */
function ConnectionDialog({
  collection,
  onClose,
}: {
  collection: RdCollection;
  onClose: () => void;
}) {
  const [username, setUsername] = useState("");

  return (
    <Modal
      title={`Connection file for ${collection.name}`}
      submitLabel="Download"
      onClose={onClose}
      onSubmit={() => {
        if (!username) return;
        // A download rather than a fetch: the browser saves the file, and the
        // API records who asked for it.
        window.location.href = api.rd.connectionUrl(collection.id, username);
        onClose();
      }}
    >
      <Field label="Person" hint="Their sign-in name, which is what the broker routes on">
        <PickerField
          kind="user"
          as="name"
          ariaLabel="Person"
          value={username}
          required
          placeholder="jdoe"
          onChange={setUsername}
        />
      </Field>
      <p className="muted">
        The file connects to {collection.broker_fqdn}, which sends them to the host they were last
        on. Opening it on any machine with an RDP client signs them in with their domain password.
      </p>
    </Modal>
  );
}


/**
 * The profile disks on a collection's share.
 *
 * A disk that has filled up is a person whose desktop will not start, and
 * finding that out otherwise means signing in to a session host and running
 * du. Asked of a host rather than of the file server, because the host is what
 * has the share mounted with the credentials that can read it.
 */
function ProfileDisks({ collections }: { collections: RdCollection[] }) {
  const hosts = collections.flatMap((collection) => collection.hosts);
  const [node, setNode] = useState(hosts[0] ?? "");
  const [store, setStore] = useState("");
  const [disks, setDisks] = useState<ProfileDisk[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [managing, setManaging] = useState<ProfileDisk | null>(null);

  const load = useCallback(async () => {
    if (!node) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.rd.profiles(node);
      setStore(result.store);
      setDisks(result.disks);
    } catch (err) {
      setDisks([]);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [node]);

  useEffect(() => {
    void load();
  }, [load]);

  if (hosts.length === 0) {
    return <p className="empty">No session host is in a collection, so there is no share to read.</p>;
  }

  return (
    <>
      <div className="page-header">
        <Field label="Read the share from">
          <Select value={node} onChange={(e) => setNode(e.target.value)}>
            {hosts.map((host) => (
              <option key={host} value={host}>
                {host}
              </option>
            ))}
          </Select>
        </Field>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {store && <p className="mono muted">{store}</p>}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}

      <table className="data">
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col" style={{ width: "140px" }}>
              Used
            </th>
            <th scope="col" style={{ width: "140px" }}>
              May grow to
            </th>
            <th scope="col" style={{ width: "140px" }}>
              In use
            </th>
            <th scope="col" style={{ width: "180px" }}>
              Last changed
            </th>
            <th scope="col" style={{ width: "110px" }}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {disks.map((disk) => (
            <tr key={disk.user}>
              <td>{disk.user}</td>
              <td className="mono">{bytes(disk.used_bytes)}</td>
              <td className="mono">{bytes(disk.size_bytes)}</td>
              <td>{disk.in_use ? <span className="badge">Signed in</span> : "—"}</td>
              <td>{disk.modified ? new Date(disk.modified).toLocaleString() : "—"}</td>
              <td>
                <button
                  type="button"
                  className="ghost"
                  disabled={disk.in_use}
                  onClick={() => setManaging(disk)}
                >
                  Manage…
                </button>
              </td>
            </tr>
          ))}
          {loading ? (
            <LoadingRow colSpan={6} />
          ) : (
            disks.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No profile disks on this share yet. One is made the first time somebody signs in.
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>

      {managing && (
        <ProfileDiskDialog
          node={node}
          disk={managing}
          onClose={() => setManaging(null)}
          onDone={(message) => {
            setManaging(null);
            setNotice(message);
            void load();
          }}
        />
      )}
    </>
  );
}

function ProfileDiskDialog({
  node,
  disk,
  onClose,
  onDone,
}: {
  node: string;
  disk: ProfileDisk;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [action, setAction] = useState<"grow" | "reset">("grow");
  const [sizeGb, setSizeGb] = useState(Math.max(1, Math.ceil(disk.size_bytes / 1024 ** 3) + 5));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={`${disk.user}'s profile disk`}
      submitLabel={busy ? "Working…" : action === "grow" ? "Grow it" : "Set it aside"}
      onClose={onClose}
      onSubmit={async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
          const result = await api.rd.manageProfile({
            node_fqdn: node,
            user: disk.user,
            action,
            size_gb: action === "grow" ? sizeGb : undefined,
          });
          onDone(result.result);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
          setBusy(false);
        }
      }}
    >
      <p className="mono muted">{disk.path}</p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <Field label="What to do">
        <Select value={action} onChange={(e) => setAction(e.target.value as "grow" | "reset")}>
          <option value="grow">Let it grow further</option>
          <option value="reset">Set it aside and build a new one</option>
        </Select>
      </Field>
      {action === "grow" ? (
        <Field label="May grow to (GB)" hint="A profile disk is never made smaller">
          <input
            type="number"
            min={1}
            max={2048}
            value={sizeGb}
            onChange={(e) => setSizeGb(Number(e.target.value))}
          />
        </Field>
      ) : (
        <p className="alert" role="alert">
          The disk is renamed, never deleted — a profile that will not mount still holds
          somebody&rsquo;s work. Their next sign-in builds a new one beside it, and they start
          with an empty desktop.
        </p>
      )}
    </Modal>
  );
}

/** A size somebody reads rather than counts. */
function bytes(value: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}
