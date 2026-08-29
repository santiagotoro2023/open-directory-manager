import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type RoleArgument, type RoleInstance } from "../api";
import { Field } from "./Modal";
import { ScopeSelector } from "./ScopeSelector";

/**
 * The settings a role takes after it exists.
 *
 * Installing a role and configuring the service it provides are different
 * jobs: one is a server gaining a capability, the other is how that capability
 * behaves. Pairing two DHCP nodes for failover belongs here, under DHCP, not
 * in the install dialog on a page about which machines run what.
 */
export function RoleConfiguration({
  role,
  title,
  description,
}: {
  role: string;
  title: string;
  description?: string;
}) {
  const [argumentsFor, setArgumentsFor] = useState<RoleArgument[]>([]);
  const [instances, setInstances] = useState<RoleInstance[]>([]);
  const [node, setNode] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.roles.list();
      const descriptor = result.available.find((entry) => entry.name === role);
      setArgumentsFor((descriptor?.arguments ?? []).filter((argument) => argument.configuration));
      const running = result.installed.filter(
        (instance) => instance.role_name === role && instance.state !== "removed",
      );
      setInstances(running);
      setNode((current) => current || running[0]?.node_fqdn || "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [role]);

  useEffect(() => {
    void load();
  }, [load]);

  // Each server holds its own configuration; switching server shows that one.
  useEffect(() => {
    const instance = instances.find((entry) => entry.node_fqdn === node);
    setValues(instance ? { ...instance.config } : {});
  }, [node, instances]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const instance = instances.find((entry) => entry.node_fqdn === node);
      // The stored install-time settings are kept: this form only carries the
      // configuration ones, and sending it alone would drop the rest.
      await api.roles.install(role, node, { ...instance?.config, ...values });
      setNotice(`Applying on ${node}. The state moves to active when it is done.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (instances.length === 0) {
    return (
      <p className="empty">
        No server carries this role yet. Add it under Server Roles first.
      </p>
    );
  }

  return (
    <>
      <h3 className="section-title">{title}</h3>
      {description && <p className="muted">{description}</p>}

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}

      <Field label="Server">
        <select value={node} onChange={(e) => setNode(e.target.value)}>
          {instances.map((instance) => (
            <option key={instance.id} value={instance.node_fqdn}>
              {instance.node_fqdn} — {instance.state}
            </option>
          ))}
        </select>
      </Field>

      <div className="field-grid">
        {argumentsFor
          .filter((argument) => argument.kind !== "networks")
          .map((argument) => (
            <Field
              key={argument.name}
              label={argument.label}
              hint={argument.help || (argument.optional ? "Optional" : undefined)}
            >
              {argument.kind === "choice" ? (
                <select
                  value={values[argument.name] ?? ""}
                  onChange={(e) => setValues({ ...values, [argument.name]: e.target.value })}
                >
                  <option value="">Not set</option>
                  {argument.choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={values[argument.name] ?? ""}
                  placeholder={argument.placeholder || argument.default}
                  onChange={(e) => setValues({ ...values, [argument.name]: e.target.value })}
                />
              )}
            </Field>
          ))}
      </div>

      {/* A network is chosen from the DHCP server rather than typed: the
          scopes are what boot is advertised in. */}
      {argumentsFor
        .filter((argument) => argument.kind === "networks")
        .map((argument) => (
          <div key={argument.name}>
            <h3 className="section-title">{argument.label}</h3>
            {argument.help && <p className="muted">{argument.help}</p>}
            <ScopeSelector
              value={values[argument.name] ?? ""}
              onChange={(next) => setValues({ ...values, [argument.name]: next })}
            />
          </div>
        ))}

      <div className="actions-row">
        <button type="button" className="primary" disabled={busy || !node} onClick={() => void save()}>
          Apply
        </button>
      </div>
    </>
  );
}
