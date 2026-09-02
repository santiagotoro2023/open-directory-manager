import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { ApiError, api, type DhcpLease, type DhcpScope } from "../api";
import { InfoPanel } from "../components/DocsLink";
import { Field, Modal } from "../components/Modal";
import { Wizard } from "../components/Wizard";
import { RoleConfiguration } from "../components/RoleConfiguration";
import Select from "../components/Select"

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
  const [dialog, setDialog] = useState<"scope" | "reservation" | "edit" | null>(null);
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
        Scopes hand out addresses and the options that go with them: the gateway, the DNS servers
        and the search domain. Leases show what is currently held, and are registered in the
        domain&rsquo;s DNS as they are issued.
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
                  {optionOf(scope, "domain-name-servers") ? (
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
                      setDialog("edit");
                    }}
                  >
                    <Pencil size={14} aria-hidden="true" />
                    Edit
                  </button>
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
      {dialog === "edit" && target && (
        <EditScopeDialog
          scope={target}
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

/** The options a client is handed, short enough for a column. */
function handsOut(scope: DhcpScope): string {
  return [optionOf(scope, "domain-name-servers"), optionOf(scope, "domain-name")]
    .filter(Boolean)
    .join(" · ");
}

function utilisation(stats: Record<string, number>, id: number): string {
  const total = stats[`subnet[${id}].total-addresses`];
  const assigned = stats[`subnet[${id}].assigned-addresses`];
  if (total === undefined || assigned === undefined || total === 0) return "—";
  return `${assigned} / ${total} (${Math.round((assigned / total) * 100)}%)`;
}

/** Everything a scope holds, as state, whether it is being made or changed. */
function useScopeForm(scope?: DhcpScope) {
  const existing = scope?.pools?.[0]?.pool ?? "";
  const [subnet, setSubnet] = useState(scope?.subnet ?? "");
  const [from, setFrom] = useState(existing.split("-")[0]?.trim() ?? "");
  const [to, setTo] = useState(existing.split("-")[1]?.trim() ?? "");
  const [routers, setRouters] = useState(optionOf(scope, "routers"));
  const [dnsServers, setDnsServers] = useState(optionOf(scope, "domain-name-servers"));
  const [domainName, setDomainName] = useState(optionOf(scope, "domain-name"));
  const [comment, setComment] = useState(scope?.["user-context"]?.comment ?? "");

  const prefix = prefixOf(subnet);

  // The domain's own values, filled in rather than left to be remembered. A
  // scope built without them hands out an address and nothing else, and every
  // name a client is given afterwards — a share, the controller it should
  // join — fails to resolve. Only for a new scope: an existing one that
  // deliberately hands out something else must not be quietly rewritten.
  useEffect(() => {
    if (scope) return;
    api.dhcp
      .defaults()
      .then((defaults) => {
        setDnsServers((current) => current || defaults.dns_servers.join(", "));
        setDomainName((current) => current || defaults.domain_name);
      })
      .catch(() => undefined);
  }, [scope]);

  // The rest of the network, as soon as it is known. Every one of these is the
  // usual answer and every one of them is still editable: the gateway at .1,
  // a pool over the top half, leaving the bottom for fixed addresses.
  useEffect(() => {
    if (!prefix || scope) return;
    setRouters((current) => current || `${prefix}1`);
    setFrom((current) => current || `${prefix}100`);
    setTo((current) => current || `${prefix}254`);
  }, [prefix, scope]);

  function body() {
    const options = [];
    if (routers) options.push({ name: "routers", data: routers });
    if (dnsServers) options.push({ name: "domain-name-servers", data: dnsServers });
    if (domainName) options.push({ name: "domain-name", data: domainName });
    return {
      subnet,
      pools: from && to ? [{ pool: `${from} - ${to}` }] : [],
      option_data: options,
      comment,
    };
  }

  const network = (
    <Field label="Subnet" hint="The network this scope serves, as CIDR">
      <input
        value={subnet}
        required
        disabled={Boolean(scope)}
        placeholder="10.10.0.0/24"
        onChange={(e) => setSubnet(e.target.value)}
      />
    </Field>
  );

  const addresses = (
    <>
      <div className="inline-fields">
        <Field label="From" hint="The first address handed out">
          <AddressInput
            prefix={prefix}
            value={from}
            ariaLabel="First address"
            placeholder={prefix ? "100" : "10.10.0.100"}
            onChange={setFrom}
          />
        </Field>
        <Field label="To" hint="The last one">
          <AddressInput
            prefix={prefix}
            value={to}
            ariaLabel="Last address"
            placeholder={prefix ? "254" : "10.10.0.200"}
            onChange={setTo}
          />
        </Field>
      </div>
      <p className="muted">
        {from && to
          ? `Clients are given ${from} to ${to}. Everything outside that stays free for machines with a fixed address.`
          : "Leave both empty to hand out no addresses at all — a scope for reservations only."}
      </p>
    </>
  );

  const handout = (
    <>
      <Field label="Routers" hint="The default gateway on this subnet">
        <AddressInput
          prefix={prefix}
          value={routers}
          ariaLabel="Routers"
          placeholder={prefix ? "1" : "10.10.0.1"}
          onChange={setRouters}
        />
      </Field>
      <Field
        label="DNS servers"
        hint="Comma separated, in the order clients should try them. The domain controllers: a client given anything else cannot resolve the domain, its shares, or the records a join needs."
      >
        <input
          value={dnsServers}
          placeholder="10.10.0.10, 10.10.0.11"
          onChange={(e) => setDnsServers(e.target.value)}
        />
      </Field>
      <Field label="Domain name" hint="The search domain clients on this subnet are given">
        <input
          value={domainName}
          placeholder="corp.example.internal"
          onChange={(e) => setDomainName(e.target.value)}
        />
      </Field>
      <Field label="Comment" hint="Shown in the scope list">
        <input value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
    </>
  );

  return { subnet, prefix, body, fields: { network, addresses, handout } };
}

function optionOf(scope: DhcpScope | undefined, name: string): string {
  return scope?.["option-data"]?.find((entry) => entry.name === name)?.data ?? "";
}

function ScopeDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const form = useScopeForm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          incomplete: !form.subnet ? "Give the subnet this scope serves." : undefined,
          fields: form.fields.network,
        },
        {
          title: "Addresses to hand out",
          hint: "The range clients are given. Anything outside it stays free for machines with a fixed address.",
          fields: form.fields.addresses,
        },
        {
          title: "What clients are told",
          hint: "An address on its own gets a machine onto the wire and no further.",
          fields: form.fields.handout,
        },
      ]}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.dhcp.createScope(form.body());
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

/** An existing scope, changed.
 *
 * Without this, a scope that was created without its DNS servers could only be
 * deleted and made again — taking its reservations with it. */
function EditScopeDialog({
  scope,
  onClose,
  onSaved,
}: {
  scope: DhcpScope;
  onClose: () => void;
  onSaved: () => void;
}) {
  const form = useScopeForm(scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={`Scope ${scope.subnet}`}
      submitLabel="Save"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.dhcp.updateScope({ id: scope.id, ...form.body() });
          onSaved();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {form.fields.network}
      <h3 className="section-title">Addresses to hand out</h3>
      {form.fields.addresses}
      <h3 className="section-title">What clients are told</h3>
      {form.fields.handout}
      <p className="muted">
        Reservations in this scope are left as they are. Change is tested against the DHCP service
        before it is applied, so one it would refuse leaves the running configuration alone.
      </p>
    </Modal>
  );
}

/** The part of the subnet every address on it shares: "172.16.110." for a /24.
 *
 * Empty for anything that is not a plain IPv4 /24 — this exists to save typing
 * the obvious, not to guess at a network it cannot read. */
function prefixOf(subnet: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)\.\d+\/(\d+)$/.exec(subnet.trim());
  if (!match || Number(match[4]) !== 24) return "";
  return `${match[1]}.${match[2]}.${match[3]}.`;
}

/**
 * An address on a known network, typed as the part that differs.
 *
 * The subnet is already on screen; typing it again for the pool, the gateway
 * and every reservation is work the console can do. The prefix sits beside the
 * field, "50" becomes 172.16.110.50, and an address typed in full — on this
 * network or another — is still taken as it stands.
 */
function AddressInput({
  prefix,
  value,
  placeholder,
  required,
  ariaLabel,
  onChange,
}: {
  prefix: string;
  value: string;
  placeholder?: string;
  required?: boolean;
  ariaLabel?: string;
  onChange: (value: string) => void;
}) {
  if (!prefix) {
    return (
      <input
        value={value}
        required={required}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  const shown = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return (
    <div className="prefixed-input">
      <span aria-hidden="true">{prefix}</span>
      <input
        value={shown}
        required={required}
        aria-label={ariaLabel}
        placeholder={placeholder}
        inputMode="numeric"
        onChange={(e) => {
          const typed = e.target.value.trim();
          // A full address, typed or pasted, is what it says it is.
          onChange(typed.includes(".") || typed === "" ? typed : prefix + typed);
        }}
      />
    </div>
  );
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
  const [leases, setLeases] = useState<DhcpLease[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefix = prefixOf(scope.subnet);

  // What is on this network right now, so a reservation can be made from it.
  useEffect(() => {
    api.dhcp
      .leases()
      .then((result) =>
        setLeases(result.leases.filter((lease) => lease["subnet-id"] === scope.id)),
      )
      .catch(() => setLeases([]));
  }, [scope.id]);

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

      {/* A reservation is nearly always "keep the address this machine has".
          Reading the hardware address off a label, or off the machine, to type
          it back in is work the lease list has already done. */}
      {leases.length > 0 && (
        <Field label="From a lease" hint="Fills the three fields below from what a machine holds now">
          <Select
            aria-label="From a lease"
            value=""
            onChange={(e) => {
              const lease = leases.find((entry) => entry["ip-address"] === e.target.value);
              if (!lease) return;
              setHwAddress(lease["hw-address"]);
              setIpAddress(lease["ip-address"]);
              setHostname(lease.hostname ?? "");
            }}
          >
            <option value="">Choose a machine…</option>
            {leases.map((lease) => (
              <option key={lease["ip-address"]} value={lease["ip-address"]}>
                {lease["ip-address"]} — {lease.hostname || lease["hw-address"]}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Hardware address" hint="Six pairs of hex digits, e.g. 00:11:22:33:44:55">
        <input
          value={hwAddress}
          required
          placeholder="00:11:22:33:44:55"
          onChange={(e) => setHwAddress(e.target.value)}
        />
      </Field>
      <Field label="IP address" hint={`Inside ${scope.subnet}, and outside the pool if it has one`}>
        <AddressInput
          prefix={prefix}
          value={ipAddress}
          required
          ariaLabel="IP address"
          placeholder={prefix ? "50" : "10.10.0.50"}
          onChange={setIpAddress}
        />
      </Field>
      <Field label="Host name" hint="What the machine is registered in DNS as">
        <input value={hostname} onChange={(e) => setHostname(e.target.value)} />
      </Field>
    </Modal>
  );
}
