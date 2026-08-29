import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Server } from "lucide-react";
import {
  ApiError,
  api,
  type RoleArgument,
  type RoleDescriptor,
  type RoleInstance,
} from "../api";
import { Field, Modal } from "../components/Modal";

const STATE_BADGE: Record<string, string> = {
  active: "success",
  failed: "failure",
  installing: "",
  pending: "",
  removed: "",
};

export function Roles() {
  const [available, setAvailable] = useState<RoleDescriptor[]>([]);
  const [installed, setInstalled] = useState<RoleInstance[]>([]);
  const [nodes, setNodes] = useState<string[]>([]);
  const [open, setOpen] = useState<RoleDescriptor | null>(null);
  const [installing, setInstalling] = useState<RoleDescriptor | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.roles.list();
      setAvailable(result.available);
      setInstalled(result.installed);
      setNodes(result.nodes);
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

  function nodesFor(role: RoleDescriptor): RoleInstance[] {
    return installed.filter(
      (instance) => instance.role_name === role.name && instance.state !== "removed",
    );
  }

  return (
    <main className="content">
      <div className="page-header">
        <h1>Server Roles</h1>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {available.map((role) => {
        const running = nodesFor(role);
        return (
          <button
            type="button"
            key={role.name}
            className="role-row"
            onClick={() => setOpen(role)}
            aria-label={`Open ${role.title}`}
          >
            <Server size={18} aria-hidden="true" />
            <span>
              <span className="role-name">{role.title}</span>
              <br />
              <span className="role-summary">
                {role.core
                  ? "Always on"
                  : running.length === 0
                    ? "Not installed"
                    : running.map((instance) => instance.node_fqdn).join(", ")}
              </span>
            </span>
            <span className="spacer" />
            {role.core ? (
              <span className="badge success">always on</span>
            ) : (
              running.map((instance) => (
                <span key={instance.id} className={`badge ${STATE_BADGE[instance.state] ?? ""}`}>
                  {instance.state}
                </span>
              ))
            )}
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        );
      })}

      {open && (
        <RoleDetail
          role={open}
          instances={nodesFor(open)}
          onClose={() => setOpen(null)}
          onInstall={() => {
            setInstalling(open);
            setOpen(null);
          }}
          onChanged={() => void load()}
        />
      )}

      {installing && (
        <InstallDialog
          role={installing}
          nodes={nodes}
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

function RoleDetail({
  role,
  instances,
  onClose,
  onInstall,
  onChanged,
}: {
  role: RoleDescriptor;
  instances: RoleInstance[];
  onClose: () => void;
  onInstall: () => void;
  onChanged: () => void;
}) {
  return (
    <Modal
      title={role.title}
      submitLabel={role.core ? "Close" : "Install on a server"}
      onClose={onClose}
      onSubmit={() => (role.core ? onClose() : onInstall())}
    >
      <p>{role.summary}</p>

      <h3 className="section-title">Servers</h3>
      <table className="data compact">
        <thead>
          <tr>
            <th scope="col">Server</th>
            <th scope="col">State</th>
            <th scope="col">Installed</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {instances.map((instance) => (
            <tr key={instance.id}>
              <td className="mono">{instance.node_fqdn}</td>
              <td>
                <span className={`badge ${STATE_BADGE[instance.state] ?? ""}`}>
                  {instance.state}
                </span>
                {instance.last_error && <p className="muted">{instance.last_error}</p>}
              </td>
              <td>
                {instance.installed_at
                  ? new Date(instance.installed_at).toLocaleDateString()
                  : "—"}
              </td>
              <td>
                <button
                  type="button"
                  className="ghost"
                  onClick={async () => {
                    await api.roles.remove(instance.id).catch(() => undefined);
                    onChanged();
                  }}
                >
                  Deregister
                </button>
              </td>
            </tr>
          ))}
          {instances.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                {role.core ? "Runs on every domain controller." : "Not installed on any server."}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {(role.packages.length > 0 || role.notes) && (
        <>
          <h3 className="section-title">Details</h3>
          <dl className="definition">
            {role.packages.length > 0 && (
              <>
                <dt>Packages</dt>
                <dd className="mono">{role.packages.join(", ")}</dd>
              </>
            )}
            {role.notes && (
              <>
                <dt>Note</dt>
                <dd>{role.notes}</dd>
              </>
            )}
          </dl>
        </>
      )}
    </Modal>
  );
}

function ArgumentField({
  argument,
  value,
  onChange,
}: {
  argument: RoleArgument;
  value: string;
  onChange: (value: string) => void;
}) {
  const required = !argument.optional;
  const hint = argument.help || (argument.optional ? "Optional" : undefined);

  if (argument.kind === "choice") {
    return (
      <Field label={argument.label} hint={hint}>
        <select value={value || argument.default} onChange={(e) => onChange(e.target.value)}>
          {argument.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  return (
    <Field label={argument.label} hint={hint}>
      <input
        value={value}
        required={required}
        placeholder={argument.placeholder || argument.default}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function InstallDialog({
  role,
  nodes,
  onClose,
  onStarted,
}: {
  role: RoleDescriptor;
  nodes: string[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const [node, setNode] = useState(nodes[0] ?? "");
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
      {/* The domain's controllers are offered, but a role may legitimately run
          on a member server, so the field stays free text. */}
      <Field label="Server" hint="Fully-qualified name of the machine">
        <input
          value={node}
          required
          list="odm-role-nodes"
          placeholder="dc1.corp.example.internal"
          onChange={(e) => setNode(e.target.value)}
        />
      </Field>
      <datalist id="odm-role-nodes">
        {nodes.map((candidate) => (
          <option key={candidate} value={candidate} />
        ))}
      </datalist>

      {role.arguments.map((argument) => (
        <ArgumentField
          key={argument.name}
          argument={argument}
          value={config[argument.name] ?? ""}
          onChange={(value) => setConfig({ ...config, [argument.name]: value })}
        />
      ))}

      {role.produces_settings.length > 0 && (
        <p className="muted">
          Add the {role.produces_settings.join(", ")} lines the installer prints to the secrets
          file.
        </p>
      )}
    </Modal>
  );
}
