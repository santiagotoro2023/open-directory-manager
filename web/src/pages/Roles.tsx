import { useCallback, useEffect, useState } from "react";
import { Server } from "lucide-react";
import { ApiError, api, type RoleDescriptor, type RoleInstance } from "../api";
import { Field, Modal } from "../components/Modal";

const STATE_BADGE: Record<string, string> = {
  active: "success",
  failed: "failure",
  installing: "",
  pending: "",
  removed: "",
};

function label(argument: string): string {
  return argument.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function Roles() {
  const [available, setAvailable] = useState<RoleDescriptor[]>([]);
  const [installed, setInstalled] = useState<RoleInstance[]>([]);
  const [installing, setInstalling] = useState<RoleDescriptor | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.roles.list();
      setAvailable(result.available);
      setInstalled(result.installed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // An install is apt work and service restarts; poll while one is running.
  useEffect(() => {
    if (!installed.some((instance) => instance.state === "installing")) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [installed, load]);

  return (
    <main className="content">
      <h1>Server Roles</h1>
      <p className="muted">
        A fresh install runs Active Directory, Group Policy and DNS. Everything else is added
        here, without redeploying the base system.
      </p>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <h2>Installed</h2>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Node</th>
            <th scope="col">State</th>
            <th scope="col">Installed</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {installed.map((instance) => (
            <tr key={instance.id}>
              <td>{instance.role_name}</td>
              <td className="mono">{instance.node_fqdn}</td>
              <td>
                <span className={`badge ${STATE_BADGE[instance.state] ?? ""}`}>
                  {instance.state}
                </span>
                {instance.last_error && <p className="muted">{instance.last_error}</p>}
              </td>
              <td>
                {instance.installed_at
                  ? new Date(instance.installed_at).toLocaleString()
                  : "—"}
              </td>
              <td>
                <button
                  type="button"
                  className="ghost"
                  onClick={async () => {
                    await api.roles.remove(instance.id).catch(() => undefined);
                    await load();
                  }}
                >
                  Deregister
                </button>
              </td>
            </tr>
          ))}
          {installed.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Only the core role is running.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Available</h2>
      <div className="role-cards">
        {available.map((role) => (
          <article key={role.name} className="role-card">
            <h3>
              <Server size={15} aria-hidden="true" />
              {role.title}
            </h3>
            <p>{role.summary}</p>
            {role.packages.length > 0 && (
              <p className="muted mono">{role.packages.join(", ")}</p>
            )}
            {role.core ? (
              <span className="badge success">always on</span>
            ) : (
              <button type="button" className="ghost" onClick={() => setInstalling(role)}>
                Install
              </button>
            )}
          </article>
        ))}
      </div>

      {installing && (
        <InstallDialog
          role={installing}
          onClose={() => setInstalling(null)}
          onStarted={() => {
            setInstalling(null);
            void load();
          }}
        />
      )}
    </main>
  );
}

function InstallDialog({
  role,
  onClose,
  onStarted,
}: {
  role: RoleDescriptor;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [node, setNode] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={`Install ${role.title}`}
      submitLabel="Install"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.roles.install(role.name, node, config);
          onStarted();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="muted">{role.summary}</p>
      {role.notes && <p className="muted">{role.notes}</p>}

      <Field label="Node" hint="Fully-qualified name of the machine the role runs on">
        <input value={node} required onChange={(e) => setNode(e.target.value)} />
      </Field>

      {role.arguments.map((argument) => (
        <Field
          key={argument}
          label={label(argument)}
          hint={role.optional_arguments.includes(argument) ? "Optional" : undefined}
        >
          <input
            value={config[argument] ?? ""}
            required={!role.optional_arguments.includes(argument)}
            onChange={(e) => setConfig({ ...config, [argument]: e.target.value })}
          />
        </Field>
      ))}

      {role.produces_settings.length > 0 && (
        <p className="muted">
          When it finishes, the installer prints {role.produces_settings.join(", ")} to add to the
          secrets file.
        </p>
      )}
    </Modal>
  );
}
