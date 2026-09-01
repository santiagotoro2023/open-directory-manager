import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronRight, Server } from "lucide-react";
import {
  ApiError,
  api,
  type DomainController,
  type ManagedServer,
  type RoleArgument,
  type RoleDescriptor,
  type RoleInstance,
} from "../api";
import { Field, Modal } from "../components/Modal";
import { PickerField } from "../components/Picker";
import Select from "../components/Select"

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
  const [open, setOpen] = useState<RoleDescriptor | null>(null);
  const [installing, setInstalling] = useState<RoleDescriptor | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The core role runs on the controllers, so name them rather than saying so.
  const [controllers, setControllers] = useState<DomainController[]>([]);

  useEffect(() => {
    api.controllers
      .list()
      .then((result) => setControllers(result.controllers))
      .catch(() => setControllers([]));
  }, []);

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
                  ? controllers.length
                    ? controllers.map((dc) => dc.name).join(", ")
                    : "Every domain controller"
                  : running.length === 0
                    ? "Not installed"
                    : running.map((instance) => instance.node_fqdn).join(", ")}
              </span>
            </span>
            <span className="spacer" />
            {role.core ? (
              <span className="badge success">active</span>
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
          controllers={controllers}
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
  controllers,
  onClose,
  onInstall,
  onChanged,
}: {
  role: RoleDescriptor;
  instances: RoleInstance[];
  controllers: DomainController[];
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
            <th scope="col" style={{ width: "110px" }}>
              State
            </th>
            <th scope="col" style={{ width: "100px" }}>
              Installed
            </th>
            <th scope="col" style={{ width: "110px" }}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {/* The core role is not installed anywhere: it is what a controller
              is. So list the controllers, which is the answer to the question
              the table is being asked. */}
          {role.core &&
            controllers.map((dc) => (
              <tr key={dc.distinguished_name}>
                <td className="mono">{dc.fqdn || dc.name}</td>
                <td>
                  <span className="badge success">active</span>
                </td>
                <td>{dc.read_only ? "read-only" : "writable"}</td>
                <td />
              </tr>
            ))}
          {instances.map((instance) => (
            <Fragment key={instance.id}>
              <tr>
                <td className="mono">{instance.node_fqdn}</td>
                <td>
                  <span className={`badge ${STATE_BADGE[instance.state] ?? ""}`}>
                    {instance.state}
                  </span>
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
              {/* An installer's last words are often several lines of shell
                  output. Squeezed into the state column it turned a table into
                  a wall one word wide, so it gets the full width underneath. */}
              {instance.last_error && (
                <tr className="detail-row">
                  <td colSpan={4}>
                    <pre className="failure-output">{instance.last_error}</pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {instances.length === 0 && !(role.core && controllers.length > 0) && (
            <tr>
              <td colSpan={4} className="empty">
                {role.core ? "No controller has reported in yet." : "Not installed on any server."}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {(role.packages.length > 0 || role.notes) && (
        <div className="role-details">
          {role.packages.length > 0 && (
            <p className="muted">
              Installs <span className="mono">{role.packages.join(", ")}</span>
            </p>
          )}
          {role.notes && <p className="muted">{role.notes}</p>}
        </div>
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
        <Select value={value || argument.default} onChange={(e) => onChange(e.target.value)}>
          {argument.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </Select>
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
  const [servers, setServers] = useState<ManagedServer[]>([]);

  useEffect(() => {
    api.servers
      .list()
      .then((result) => setServers(result.servers))
      .catch(() => setServers([]));
  }, []);

  // The agent on the target machine is what installs a role. Picking a machine
  // that has never run one means watching "installing" until somebody works
  // out why — so say it before the click, not after the wait.
  const chosen = servers.find((server) => server.fqdn.toLowerCase() === node.trim().toLowerCase());
  const silent = node.trim() !== "" && chosen !== undefined && chosen.last_seen === null;

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
      {/* Any joined machine can carry a role, not just a controller, so the
          picker searches every computer in the domain. */}
      <Field label="Server" hint="The machine this role runs on">
        <PickerField
          kind="computer"
          as="host"
          ariaLabel="Server"
          value={node}
          required
          placeholder="fs01.corp.example.internal"
          onChange={setNode}
        />
      </Field>

      {role.arguments
        .filter((argument) => !argument.configuration)
        .map((argument) => (
          <ArgumentField
            key={argument.name}
            argument={argument}
            value={config[argument.name] ?? ""}
            onChange={(value) => setConfig({ ...config, [argument.name]: value })}
          />
        ))}

      {silent && (
        <p className="alert" role="alert">
          {chosen?.name} has never reported in, so it is probably not running the agent — and the
          agent is what installs a role. Install it there first, or this will sit at
          &ldquo;installing&rdquo; until it does.
        </p>
      )}

      {role.produces_settings.length > 0 && (
        <p className="muted">
          Add the {role.produces_settings.join(", ")} lines the installer prints to the secrets
          file.
        </p>
      )}
    </Modal>
  );
}
