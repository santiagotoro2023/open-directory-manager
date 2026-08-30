import { useCallback, useEffect, useState } from "react";
import { Download, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { ApiError, api, type VpnPeer, type VpnTunnel } from "../api";
import { Field, Modal } from "../components/Modal";
import { PickerDialog, PickerField } from "../components/Picker";
import { ScopeSelector } from "../components/ScopeSelector";
import { Split } from "../components/Split";

const STATE_BADGE: Record<string, string> = {
  active: "success",
  failed: "failure",
  applying: "",
  pending: "",
};

export function Vpn() {
  const [tunnels, setTunnels] = useState<VpnTunnel[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.vpn.list();
      setTunnels(result.tunnels);
      setSelected((current) => current || result.tunnels[0]?.id || "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const tunnel = tunnels.find((entry) => entry.id === selected);

  const list = (
    <>
      <div className="pane-actions">
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          <Plus size={15} aria-hidden="true" />
          New tunnel
        </button>
      </div>
      <ul className="pane-list" aria-label="Tunnels">
        {tunnels.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className={selected === entry.id ? "active" : ""}
              onClick={() => setSelected(entry.id)}
            >
              <ShieldCheck size={15} aria-hidden="true" />
              <span className="truncate">{entry.name}</span>
            </button>
          </li>
        ))}
        {tunnels.length === 0 && <li className="empty">No tunnels yet.</li>}
      </ul>
    </>
  );

  return (
    <Split id="vpn" label="Resize the tunnel list" initial={260} side={list}>
      <section className="objects">
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}

        {!tunnel ? (
          <p className="empty">
            A tunnel is a remote-access network. Create one, then add a peer for each machine or
            person who connects.
          </p>
        ) : (
          <TunnelDetail tunnel={tunnel} onChanged={() => void load()} />
        )}
      </section>

      {creating && (
        <TunnelDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </Split>
  );
}

function TunnelDetail({ tunnel, onChanged }: { tunnel: VpnTunnel; onChanged: () => void }) {
  const [peers, setPeers] = useState<VpnPeer[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPeers((await api.vpn.peers(tunnel.id)).peers);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [tunnel.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-header">
        <h1>{tunnel.name}</h1>
        <span className={`badge ${STATE_BADGE[tunnel.state] ?? ""}`}>{tunnel.state}</span>
        <span className="spacer" />
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          <Plus size={15} aria-hidden="true" />
          Add a peer
        </button>
      </div>

      {tunnel.last_error && (
        <p className="alert" role="alert">
          {tunnel.last_error}
        </p>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <dl className="definition">
        <dt>Clients dial</dt>
        <dd className="mono">
          {tunnel.endpoint}:{tunnel.listen_port}
        </dd>
        <dt>Terminated on</dt>
        <dd className="mono">{tunnel.node_fqdn}</dd>
        <dt>Tunnel network</dt>
        <dd className="mono">{tunnel.network}</dd>
        <dt>Reaches</dt>
        <dd className="mono">{tunnel.routes.join(", ") || tunnel.network}</dd>
        <dt>Name servers</dt>
        <dd className="mono">{tunnel.dns_servers.join(", ") || "none"}</dd>
      </dl>

      <h3 className="section-title">Peers</h3>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Peer</th>
            <th scope="col">Address</th>
            <th scope="col">Belongs to</th>
            <th scope="col">Always on</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {peers.map((peer) => (
            <tr key={peer.id}>
              <td>{peer.name}</td>
              <td className="mono">{peer.address}</td>
              <td className="mono">{peer.principal_dn ?? "—"}</td>
              <td>{peer.always_on ? <span className="badge">held up</span> : "—"}</td>
              <td>
                {peer.exportable && (
                  <a
                    className="ghost button-link"
                    href={api.vpn.configurationUrl(peer.id)}
                    download
                  >
                    <Download size={15} aria-hidden="true" />
                    Configuration
                  </a>
                )}
                <button
                  type="button"
                  className="icon"
                  aria-label={`Remove ${peer.name}`}
                  onClick={async () => {
                    await api.vpn.removePeer(peer.id).catch(() => undefined);
                    await load();
                    onChanged();
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
          {peers.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                No peers. Nothing can connect until one exists.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <p className="muted">
        A configuration can only be downloaded once a peer exists, and every download is recorded in
        the audit log — it contains the key that peer connects with. To hold a tunnel up on a
        machine whatever the person using it does, add its computer as a peer and set{" "}
        <strong>Always-on VPN</strong> in a policy object.
      </p>

      {adding && (
        <PeerDialog
          tunnel={tunnel}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
            onChanged();
          }}
        />
      )}
    </>
  );
}

function PeerDialog({
  tunnel,
  onClose,
  onSaved,
}: {
  tunnel: VpnTunnel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [principal, setPrincipal] = useState<string | null>(null);
  const [alwaysOn, setAlwaysOn] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={`Add a peer to ${tunnel.name}`}
      submitLabel="Add"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.vpn.addPeer({
            tunnel_id: tunnel.id,
            name,
            principal_dn: principal ?? undefined,
            always_on: alwaysOn,
          });
          onSaved();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name" hint="What this peer is, e.g. ada-laptop">
        <input value={name} required autoFocus onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field
        label="Domain object"
        hint="A computer, if this tunnel should come up on it by policy. Optional."
      >
        <div className="picker-field">
          <input value={principal ?? ""} readOnly placeholder="none" />
          <button type="button" className="ghost" onClick={() => setPicking(true)}>
            Select…
          </button>
        </div>
      </Field>
      {picking && (
        <PickerDialog
          kind="computer"
          onClose={() => setPicking(false)}
          onPick={(object) => {
            setPicking(false);
            setPrincipal(object.distinguishedName);
            if (!name) setName(String(object.cn ?? "").toLowerCase());
          }}
        />
      )}

      <label className="checkbox">
        <input type="checkbox" checked={alwaysOn} onChange={(e) => setAlwaysOn(e.target.checked)} />
        Intended to be held up by policy
      </label>
      <p className="muted">
        The address is assigned from {tunnel.network}. The key is generated here, so the
        configuration can be handed over before the machine ever connects.
      </p>
    </Modal>
  );
}

function TunnelDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [node, setNode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [port, setPort] = useState(51820);
  const [network, setNetwork] = useState("10.99.0.0/24");
  const [routes, setRoutes] = useState("");
  const [dns, setDns] = useState("");
  const [searchDomain, setSearchDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = (value: string) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

  return (
    <Modal
      title="New tunnel"
      submitLabel="Create"
      busy={busy}
      error={error}
      wide
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.vpn.create({
            node_fqdn: node,
            name,
            description,
            endpoint,
            listen_port: port,
            network,
            routes: lines(routes),
            dns_servers: lines(dns),
            search_domain: searchDomain,
          });
          onSaved();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Server" hint="A machine carrying the VPN role">
        <PickerField
          kind="computer"
          as="host"
          ariaLabel="Server"
          value={node}
          required
          placeholder="vpn01.corp.example.internal"
          onChange={setNode}
        />
      </Field>
      <Field label="Name" hint="Becomes the interface name; letters, digits and dashes">
        <input
          value={name}
          required
          placeholder="homeoffice"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Description">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <div className="inline-fields">
        <Field label="Clients dial" hint="The name or address reachable from outside">
          <input
            value={endpoint}
            required
            placeholder="vpn.example.org"
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </Field>
        <Field label="Port">
          <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
        </Field>
      </div>

      <Field
        label="Tunnel network"
        hint="Addresses given to peers. Not one of your existing networks."
      >
        <input value={network} required onChange={(e) => setNetwork(e.target.value)} />
      </Field>

      <h3 className="section-title">Which networks the tunnel reaches</h3>
      <p className="muted">
        Chosen from the DHCP scopes, so a tunnel carries the networks it is meant to and no others.
        Leave everything unticked to carry only the tunnel's own network.
      </p>
      <ScopeSelector value={routes} onChange={setRoutes} />

      <h3 className="section-title">Name resolution</h3>
      <div className="inline-fields">
        <Field label="Name servers" hint="Comma separated. A domain controller, usually.">
          <input value={dns} placeholder="10.10.0.10" onChange={(e) => setDns(e.target.value)} />
        </Field>
        <Field label="Search domain">
          <input
            value={searchDomain}
            placeholder="corp.example.internal"
            onChange={(e) => setSearchDomain(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
