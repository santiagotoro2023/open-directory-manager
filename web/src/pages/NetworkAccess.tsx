import { useCallback, useEffect, useState } from "react";
import { Plus, Router, Trash2 } from "lucide-react";
import { ApiError, api, type RadiusClient, type RadiusPolicy } from "../api";
import { LoadingRow } from "../components/Loading";
import { InfoPanel } from "../components/DocsLink";
import { Field, Modal } from "../components/Modal";
import { PickerDialog, PickerField } from "../components/Picker";
import Select from "../components/Select"

type Tab = "rules" | "devices" | "preview";

const KIND_LABELS: Record<string, string> = {
  user: "People",
  computer: "Machines",
  any: "Either",
};

/**
 * Who may get onto which network.
 *
 * A device asks — a switch, an access point, a VPN server — and a rule
 * decides, against the directory's own groups. There is no second copy of who
 * is in what.
 */
export function NetworkAccess() {
  const [tab, setTab] = useState<Tab>("rules");
  const [clients, setClients] = useState<RadiusClient[]>([]);
  const [policies, setPolicies] = useState<RadiusPolicy[]>([]);
  const [preview, setPreview] = useState("");
  const [addingClient, setAddingClient] = useState(false);
  const [addingPolicy, setAddingPolicy] = useState(false);
  const [secret, setSecret] = useState<{ name: string; secret: string; node: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.radius.overview();
      setClients(result.clients);
      setPolicies(result.policies);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab !== "preview") return;
    api.radius
      .preview()
      .then((result) => setPreview(result.policies))
      .catch(() => setPreview(""));
  }, [tab, policies]);

  return (
    <main className="content">
      <div className="page-header">
        <h1>Network Access</h1>
        <span className="spacer" />
        {tab === "devices" ? (
          <button type="button" className="primary" onClick={() => setAddingClient(true)}>
            <Plus size={15} aria-hidden="true" />
            Add a device
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => setAddingPolicy(true)}>
            <Plus size={15} aria-hidden="true" />
            New rule
          </button>
        )}
      </div>

      <InfoPanel page="network-access">
        A device asks — a switch, an access point — and a rule decides, against the directory's own groups. Denials are checked first, and a request matching no rule is refused.
      </InfoPanel>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <nav className="tabs" aria-label="Network access views">
        {(["rules", "devices", "preview"] as Tab[]).map((current) => (
          <button
            key={current}
            type="button"
            className={tab === current ? "tab active" : "tab"}
            aria-current={tab === current ? "true" : undefined}
            onClick={() => setTab(current)}
          >
            {current === "rules" ? "Rules" : current === "devices" ? "Devices" : "As evaluated"}
          </button>
        ))}
      </nav>

      {tab === "rules" && (
        <>
          <p className="muted">
            Checked in order, denials first. A request that matches nothing is refused.
          </p>
          <table className="data">
            <thead>
              <tr>
                <th scope="col" style={{ width: "80px" }}>
                  Order
                </th>
                <th scope="col">Rule</th>
                <th scope="col">Who</th>
                <th scope="col">Where</th>
                <th scope="col">Access</th>
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {policies.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.ordering}</td>
                  <td>
                    <strong>{entry.name}</strong>
                    {entry.description && <p className="muted">{entry.description}</p>}
                  </td>
                  <td>
                    {entry.group_name || entry.group_dn}
                    <span className="badge">{KIND_LABELS[entry.principal_kind]}</span>
                  </td>
                  <td>{entry.nas_identifiers.join(", ") || "Every network"}</td>
                  <td>
                    <span className={`badge ${entry.access === "allow" ? "success" : "failure"}`}>
                      {entry.access}
                    </span>
                    {entry.vlan && <span className="badge">VLAN {entry.vlan}</span>}
                    {!entry.enabled && <span className="badge">off</span>}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="icon"
                      aria-label={`Remove ${entry.name}`}
                      onClick={async () => {
                        await api.radius.removePolicy(entry.id).catch(() => undefined);
                        void load();
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
              {policies.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No rules, so nothing is allowed on. Add one for the group that should get on.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {tab === "devices" && (
        <>
          <p className="muted">
            Switches, access points and VPN servers that ask. Each has a shared secret, which is the
            only thing proving a request came from it.
          </p>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Server</th>
                <th scope="col">Address</th>
                <th scope="col">Network name</th>
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {clients.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <Router size={15} aria-hidden="true" />
                    {entry.name}
                    {entry.description && <p className="muted">{entry.description}</p>}
                  </td>
                  <td className="mono">{entry.node_fqdn}</td>
                  <td className="mono">{entry.address}</td>
                  <td>{entry.nas_identifier || "—"}</td>
                  <td>
                    <button
                      type="button"
                      className="icon"
                      aria-label={`Remove ${entry.name}`}
                      onClick={async () => {
                        await api.radius.removeClient(entry.id).catch(() => undefined);
                        void load();
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
              {loading ? (
                <LoadingRow colSpan={5} />
              ) : (
                clients.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No devices. Nothing can ask until one is added.
                  </td>
                </tr>
              )
              )}
            </tbody>
          </table>
        </>
      )}

      {tab === "preview" && (
        <>
          <p className="muted">
            The rules as the server reads them. An access decision you cannot inspect is one you
            have to guess at.
          </p>
          <pre className="wiki-code">{preview || "Nothing configured yet."}</pre>
        </>
      )}

      {addingClient && (
        <ClientDialog
          onClose={() => setAddingClient(false)}
          onAdded={(name, value, node) => {
            setAddingClient(false);
            setSecret({ name, secret: value, node });
            void load();
          }}
        />
      )}

      {addingPolicy && (
        <PolicyDialog
          networks={[...new Set(clients.map((c) => c.nas_identifier).filter(Boolean))]}
          onClose={() => setAddingPolicy(false)}
          onAdded={() => {
            setAddingPolicy(false);
            void load();
          }}
        />
      )}

      {secret && (
        <Modal
          title={`Configure ${secret.name}`}
          submitLabel="I have copied it"
          onClose={() => setSecret(null)}
          onSubmit={() => setSecret(null)}
        >
          {/* Everything that goes into the device, in one place. The secret on
              its own leaves the operator looking up the ports and the server
              address somewhere else, with a value they cannot come back for. */}
          <p>Enter these on the device. The shared secret is not shown again.</p>
          <table className="data compact">
            <tbody>
              <tr>
                <th scope="row">RADIUS server</th>
                <td className="mono selectable">{secret.node}</td>
              </tr>
              <tr>
                <th scope="row">Authentication</th>
                <td className="mono">1812/udp</td>
              </tr>
              <tr>
                <th scope="row">Accounting</th>
                <td className="mono">1813/udp</td>
              </tr>
              <tr>
                <th scope="row">Shared secret</th>
                <td className="mono selectable">{secret.secret}</td>
              </tr>
            </tbody>
          </table>
          <InfoPanel page="network-access" anchor="a-switch-and-an-access-point-worked-through">
            A lost secret is replaced by removing the device and adding it again. Ports 1812 and
            1813 have to be open between the device and the server.
          </InfoPanel>
        </Modal>
      )}
    </main>
  );
}

function ClientDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (name: string, secret: string, node: string) => void;
}) {
  const [node, setNode] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [description, setDescription] = useState("");
  const [network, setNetwork] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="Add a device"
      submitLabel="Add"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          const created = await api.radius.addClient({
            node_fqdn: node,
            name,
            address,
            description,
            nas_identifier: network,
          });
          onAdded(created.name, created.secret, node);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="RADIUS server" hint="A machine carrying the network-access role">
        <PickerField
          kind="computer"
          as="host"
          ariaLabel="RADIUS server"
          value={node}
          required
          placeholder="radius01.corp.example.internal"
          onChange={setNode}
        />
      </Field>
      <Field label="Name" hint="What this device is, e.g. core-switch">
        <input value={name} required onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Address" hint="One address, or a network for a stack of switches">
        <input
          value={address}
          required
          placeholder="10.10.0.0/24"
          onChange={(e) => setAddress(e.target.value)}
        />
      </Field>
      <Field
        label="Network name"
        hint="What the device calls this network — an SSID, a VPN name. Rules match on it."
      >
        <input
          value={network}
          placeholder="corp-wifi"
          onChange={(e) => setNetwork(e.target.value)}
        />
      </Field>
      <Field label="Description">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <p className="muted">
        A shared secret is generated and shown once. One somebody chose is one somebody could guess.
      </p>
    </Modal>
  );
}

function PolicyDialog({
  networks,
  onClose,
  onAdded,
}: {
  networks: string[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [group, setGroup] = useState<{ dn: string; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [kind, setKind] = useState<"user" | "computer" | "any">("user");
  const [chosen, setChosen] = useState<string[]>([]);
  const [access, setAccess] = useState<"allow" | "deny">("allow");
  const [vlan, setVlan] = useState("");
  const [ordering, setOrdering] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="New access rule"
      submitLabel="Create"
      busy={busy}
      error={error}
      wide
      onClose={onClose}
      onSubmit={async () => {
        if (!group) {
          setError("choose the group this rule is about");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await api.radius.addPolicy({
            name,
            description,
            group_dn: group.dn,
            group_name: group.name,
            principal_kind: kind,
            nas_identifiers: chosen,
            access,
            vlan: vlan ? Number(vlan) : null,
            ordering,
          });
          onAdded();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name">
        <input
          value={name}
          required
          placeholder="engineers-wifi"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Description">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <Field label="Group" hint="Membership comes from the directory">
        <div className="picker-field">
          <input value={group?.name ?? ""} readOnly required placeholder="none chosen" />
          <button type="button" className="ghost" onClick={() => setPicking(true)}>
            Select…
          </button>
        </div>
      </Field>
      {picking && (
        <PickerDialog
          kind="group"
          onClose={() => setPicking(false)}
          onPick={(object) => {
            setPicking(false);
            setGroup({
              dn: object.distinguishedName,
              name: String(object.sAMAccountName ?? object.cn ?? ""),
            });
          }}
        />
      )}

      <div className="inline-fields">
        <Field label="Applies to" hint="A machine authenticates as itself, not as a person">
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as "user" | "computer" | "any")}
          >
            <option value="user">People signing in</option>
            <option value="computer">Machines</option>
            <option value="any">Either</option>
          </Select>
        </Field>
        <Field label="Access">
          <Select value={access} onChange={(e) => setAccess(e.target.value as "allow" | "deny")}>
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </Select>
        </Field>
      </div>

      <h3 className="section-title">Which networks</h3>
      {networks.length === 0 ? (
        <p className="muted">
          No device has a network name yet, so this rule applies everywhere. Give your devices a
          network name to tell one from another.
        </p>
      ) : (
        <div className="actions-row">
          {networks.map((entry) => (
            <label key={entry} className="checkbox">
              <input
                type="checkbox"
                checked={chosen.includes(entry)}
                onChange={(e) =>
                  setChosen(
                    e.target.checked
                      ? [...chosen, entry]
                      : chosen.filter((value) => value !== entry),
                  )
                }
              />
              {entry}
            </label>
          ))}
        </div>
      )}

      <div className="inline-fields">
        <Field label="VLAN" hint="Optional. The session is placed in it.">
          <input
            type="number"
            value={vlan}
            placeholder="120"
            onChange={(e) => setVlan(e.target.value)}
          />
        </Field>
        <Field label="Order" hint="Lower is checked first. Denials always come before allows.">
          <input
            type="number"
            value={ordering}
            onChange={(e) => setOrdering(Number(e.target.value))}
          />
        </Field>
      </div>
    </Modal>
  );
}
