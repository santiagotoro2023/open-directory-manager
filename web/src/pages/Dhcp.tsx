import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ApiError, api, type DhcpLease, type DhcpScope } from "../api";
import { InfoPanel } from "../components/DocsLink";
import { Field, Modal } from "../components/Modal";
import { Wizard } from "../components/Wizard";
import { RoleConfiguration } from "../components/RoleConfiguration";

type Tab = "scopes" | "leases" | "configuration";

interface HaPeer {
  "server-name"?: string;
  state?: string;
  role?: string;
  "in-touch"?: boolean;
}

interface HaStatus {
  "ha-mode"?: string;
  "ha-servers"?: { local?: HaPeer; remote?: HaPeer };
}

export function Dhcp() {
  const [configured, setConfigured] = useState(true);
  const [ha, setHa] = useState<HaStatus[] | null>(null);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [scopes, setScopes] = useState<DhcpScope[]>([]);
  const [leases, setLeases] = useState<DhcpLease[]>([]);
  const [tab, setTab] = useState<Tab>("scopes");
  const [dialog, setDialog] = useState<"scope" | "reservation" | null>(null);
  const [target, setTarget] = useState<DhcpScope | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const status = await api.dhcp.status();
      setConfigured(status.configured);
      if (!status.configured) return;
      setHa((status.high_availability as HaStatus[]) ?? null);
      setStats(status.statistics ?? {});
      setScopes((await api.dhcp.scopes()).scopes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab !== "leases" || !configured) return;
    api.dhcp
      .leases()
      .then((result) => setLeases(result.leases))
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [tab, configured]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  if (!configured) {
    return (
      <main className="content">
        <h1>DHCP</h1>
        <p className="muted">
          The DHCP role is not installed. Run <code>deploy/install-dhcp-role.sh</code> on both nodes
          of the failover pair, then set ODM_KEA_URL, ODM_KEA_USER and ODM_KEA_PASSWORD in the
          secrets file.
        </p>
      </main>
    );
  }

  const local = ha?.[0]?.["ha-servers"]?.local;
  const remote = ha?.[0]?.["ha-servers"]?.remote;

  return (
    <main className="content">
      <div className="page-header">
        <h1>DHCP</h1>
        <span className="spacer" />
        <button type="button" className="primary" onClick={() => setDialog("scope")}>
          <Plus size={15} aria-hidden="true" />
          New scope
        </button>
      </div>

      {local && (
        <p className="muted">
          Failover: this node <span className="badge success">{local.state}</span> as {local.role}
          {remote && (
            <>
              {" · peer "}
              {remote["server-name"]}{" "}
              <span className={`badge ${remote["in-touch"] ? "success" : "failure"}`}>
                {remote.state ?? "unreachable"}
              </span>
            </>
          )}
        </p>
      )}

      <InfoPanel page="dhcp">
        Scopes hand out addresses and the settings that come with them — the gateway, the domain
        controllers to resolve names against, and the domain to search. Leases show what is
        currently held, and are written into DNS as they are handed out.
      </InfoPanel>

      <nav className="tabs" aria-label="DHCP views">
        {(["scopes", "leases", "configuration"] as Tab[]).map((current) => (
          <button
            key={current}
            type="button"
            className={tab === current ? "tab active" : "tab"}
            aria-current={tab === current ? "true" : undefined}
            onClick={() => setTab(current)}
          >
            {current === "scopes" ? "Scopes" : current === "leases" ? "Leases" : "Configuration"}
          </button>
        ))}
      </nav>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {tab === "scopes" && (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Subnet</th>
              <th scope="col">Pools</th>
              <th scope="col">Utilisation</th>
              <th scope="col">Reservations</th>
              <th scope="col">Hands out</th>
              <th scope="col">Comment</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {scopes.map((scope) => (
              <tr key={scope.id}>
                <td className="mono">{scope.subnet}</td>
                <td className="mono">{scope.pools.map((pool) => pool.pool).join(", ")}</td>
                <td>{utilisation(stats, scope.id)}</td>
                <td>{scope.reservations?.length ?? 0}</td>
                {/* A scope that hands out no DNS server is the usual reason a
                    client with an address still cannot reach anything by
                    name, and nothing on this page used to say so. */}
                <td>
                  {option(scope, "domain-name-servers") ? (
                    <span className="mono">{handsOut(scope)}</span>
                  ) : (
                    <span className="badge failure">no DNS server</span>
                  )}
                </td>
                <td>{scope["user-context"]?.comment ?? ""}</td>
                <td>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setTarget(scope);
                      setDialog("reservation");
                    }}
                  >
                    Reserve
                  </button>
                  <button
                    type="button"
                    className="icon"
                    aria-label={`Delete scope ${scope.subnet}`}
                    onClick={() => void run(() => api.dhcp.deleteScope(scope.id))}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
            {scopes.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No scopes configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {tab === "configuration" && (
        <RoleConfiguration
          role="dhcp"
          title="Failover"
          description="Install the role on both nodes first, then set one primary and the other standby."
        />
      )}

      {tab === "leases" && (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col">Hardware address</th>
              <th scope="col">Host name</th>
              <th scope="col">Expires</th>
            </tr>
          </thead>
          <tbody>
            {leases.map((lease) => (
              <tr key={lease["ip-address"]}>
                <td className="mono">{lease["ip-address"]}</td>
                <td className="mono">{lease["hw-address"]}</td>
                <td>{lease.hostname ?? ""}</td>
                <td>{new Date((lease.cltt + lease["valid-lft"]) * 1000).toLocaleString()}</td>
              </tr>
            ))}
            {leases.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No active leases.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {dialog === "scope" && (
        <ScopeDialog
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog === "reservation" && target && (
        <ReservationDialog
          scope={target}
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

function option(scope: DhcpScope, name: string): string {
  return scope["option-data"]?.find((entry) => entry.name === name)?.data ?? "";
}

/** The options a client is handed, short enough for a column. */
function handsOut(scope: DhcpScope): string {
  return [option(scope, "domain-name-servers"), option(scope, "domain-name")]
    .filter(Boolean)
    .join(" · ");
}

function utilisation(stats: Record<string, number>, id: number): string {
  const total = stats[`subnet[${id}].total-addresses`];
  const assigned = stats[`subnet[${id}].assigned-addresses`];
  if (total === undefined || assigned === undefined || total === 0) return "—";
  return `${assigned} / ${total} (${Math.round((assigned / total) * 100)}%)`;
}

function ScopeDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [subnet, setSubnet] = useState("");
  const [pool, setPool] = useState("");
  const [routers, setRouters] = useState("");
  const [dnsServers, setDnsServers] = useState("");
  const [domainName, setDomainName] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The domain's own values, filled in rather than left to be remembered. A
  // scope built without them hands out an address and nothing else, and every
  // name a client is given afterwards — a share, the controller it should
  // join — fails to resolve.
  useEffect(() => {
    api.dhcp
      .defaults()
      .then((defaults) => {
        setDnsServers((current) => current || defaults.dns_servers.join(", "));
        setDomainName((current) => current || defaults.domain_name);
      })
      .catch(() => undefined);
  }, []);

  // The middle of the subnet, offered rather than typed out. Everything below
  // it is left free for the switches, printers and servers that hold a fixed
  // address, which is how most networks are laid out anyway.
  const suggestedPool = suggestPool(subnet);

  return (
    <Wizard
      title="New DHCP scope"
      submitLabel="Create"
      busy={busy}
      error={error}
      onClose={onClose}
      steps={[
        {
          title: "The network",
          hint: "One scope per subnet, written as CIDR.",
          incomplete: !subnet ? "Give the subnet this scope serves." : undefined,
          fields: (
            <Field label="Subnet" hint="For example 10.10.0.0/24">
              <input
                value={subnet}
                required
                placeholder="10.10.0.0/24"
                onChange={(e) => setSubnet(e.target.value)}
              />
            </Field>
          ),
        },
        {
          title: "Addresses to hand out",
          hint: "The range clients are given. Anything outside it stays free for machines with a fixed address.",
          fields: (
            <>
              <Field label="Pool" hint="First and last address">
                <input
                  value={pool}
                  placeholder={suggestedPool || "10.10.0.100 - 10.10.0.200"}
                  onChange={(e) => setPool(e.target.value)}
                />
              </Field>
              {suggestedPool && pool !== suggestedPool && (
                <div className="actions-row">
                  <button type="button" className="ghost" onClick={() => setPool(suggestedPool)}>
                    Use {suggestedPool}
                  </button>
                </div>
              )}
            </>
          ),
        },
        {
          title: "What clients are told",
          hint: "An address on its own gets a machine onto the wire and no further.",
          fields: (
            <>
              <Field label="Routers" hint="The default gateway on this subnet">
                <input
                  value={routers}
                  placeholder="10.10.0.1"
                  onChange={(e) => setRouters(e.target.value)}
                />
              </Field>
              <Field
                label="DNS servers"
                hint="The domain controllers. A client given anything else cannot resolve the domain, its shares, or the records a join needs."
              >
                <input value={dnsServers} onChange={(e) => setDnsServers(e.target.value)} />
              </Field>
              <Field label="Domain name" hint="The search domain clients on this subnet are given">
                <input value={domainName} onChange={(e) => setDomainName(e.target.value)} />
              </Field>
              <Field label="Comment" hint="Shown in the scope list">
                <input value={comment} onChange={(e) => setComment(e.target.value)} />
              </Field>
            </>
          ),
        },
      ]}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          const options = [];
          if (routers) options.push({ name: "routers", data: routers });
          if (dnsServers) options.push({ name: "domain-name-servers", data: dnsServers });
          if (domainName) options.push({ name: "domain-name", data: domainName });
          await api.dhcp.createScope({
            subnet,
            pools: pool ? [{ pool }] : [],
            option_data: options,
            comment,
          });
          onSaved();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

/** The upper half of a subnet: a pool that leaves room for fixed addresses.
 *
 * Only for the obvious case — an IPv4 network of /16 or smaller, written as
 * CIDR. Anything else is left to be typed, rather than guessed at. */
function suggestPool(subnet: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)\.\d+\/(\d+)$/.exec(subnet.trim());
  if (!match) return "";
  const [, a, b, c, bits] = match;
  if (Number(bits) !== 24) return "";
  return `${a}.${b}.${c}.100 - ${a}.${b}.${c}.254`;
}

function ReservationDialog({
  scope,
  onClose,
  onSaved,
}: {
  scope: DhcpScope;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [hwAddress, setHwAddress] = useState("");
  const [ipAddress, setIpAddress] = useState("");
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={`Reservations in ${scope.subnet}`}
      submitLabel="Add reservation"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.dhcp.addReservation({
            subnet_id: scope.id,
            hw_address: hwAddress,
            ip_address: ipAddress,
            hostname,
          });
          onSaved();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <table className="data compact">
        <tbody>
          {(scope.reservations ?? []).map((reservation) => (
            <tr key={reservation["hw-address"]}>
              <td className="mono">{reservation["hw-address"]}</td>
              <td className="mono">{reservation["ip-address"]}</td>
              <td>{reservation.hostname ?? ""}</td>
              <td>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Remove reservation ${reservation["hw-address"]}`}
                  onClick={async () => {
                    await api.dhcp.deleteReservation(scope.id, reservation["hw-address"]);
                    onSaved();
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
          {(scope.reservations ?? []).length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No reservations yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <Field label="Hardware address" hint="00:11:22:33:44:55">
        <input value={hwAddress} required onChange={(e) => setHwAddress(e.target.value)} />
      </Field>
      <Field label="IP address" hint={`Must be inside ${scope.subnet}`}>
        <input value={ipAddress} required onChange={(e) => setIpAddress(e.target.value)} />
      </Field>
      <Field label="Host name">
        <input value={hostname} onChange={(e) => setHostname(e.target.value)} />
      </Field>
    </Modal>
  );
}
