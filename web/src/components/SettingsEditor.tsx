import { Plus, Trash2 } from "lucide-react";
import type { PolicySettings } from "../api";

type FieldKind = "text" | "number" | "textarea" | "select" | "checkbox";

interface FieldSpec {
  key: string;
  label: string;
  kind?: FieldKind;
  options?: string[];
  placeholder?: string;
  width?: string;
}

interface CategorySpec {
  key: keyof PolicySettings;
  title: string;
  note?: string;
  fields: FieldSpec[];
  blank: Record<string, unknown>;
}

// One declarative spec per policy category; the editor below renders all of
// them the same way. Field names match the API's typed schema exactly, so a
// rejected value comes back with a message pointing at the right field.
export const CATEGORIES: CategorySpec[] = [
  {
    key: "files",
    title: "File deployment",
    fields: [
      { key: "path", label: "Path", placeholder: "/etc/motd" },
      { key: "content", label: "Content", kind: "textarea" },
      { key: "mode", label: "Mode", width: "90px" },
      { key: "owner", label: "Owner", width: "110px" },
      { key: "group", label: "Group", width: "110px" },
    ],
    blank: { path: "", content: "", mode: "0644", owner: "root", group: "root" },
  },
  {
    key: "scripts",
    title: "Scripts",
    note: "Startup and shutdown run from a systemd unit; logon and logoff from a PAM hook.",
    fields: [
      {
        key: "trigger",
        label: "Trigger",
        kind: "select",
        options: ["startup", "shutdown", "logon", "logoff"],
        width: "130px",
      },
      { key: "name", label: "Name", width: "160px" },
      { key: "interpreter", label: "Interpreter", width: "140px" },
      { key: "content", label: "Script", kind: "textarea" },
    ],
    blank: { trigger: "startup", name: "", interpreter: "/bin/sh", content: "" },
  },
  {
    key: "systemd_units",
    title: "systemd units",
    fields: [
      { key: "unit", label: "Unit", placeholder: "telnet.socket" },
      {
        key: "state",
        label: "State",
        kind: "select",
        options: ["enabled", "disabled", "masked", "started", "stopped"],
        width: "140px",
      },
    ],
    blank: { unit: "", state: "enabled" },
  },
  {
    key: "cron",
    title: "Scheduled tasks",
    fields: [
      { key: "name", label: "Name", width: "160px" },
      { key: "schedule", label: "Schedule", placeholder: "0 3 * * 0", width: "150px" },
      { key: "command", label: "Command" },
      { key: "user", label: "Run as", width: "110px" },
    ],
    blank: { name: "", schedule: "0 3 * * 0", command: "", user: "root" },
  },
  {
    key: "drive_maps",
    title: "Drive maps",
    note: "Mounted with sec=krb5; no credentials are stored on the client.",
    fields: [
      { key: "name", label: "Name", width: "140px" },
      { key: "unc", label: "Share", placeholder: "//fs01/shared" },
      { key: "mount_point", label: "Mount point", placeholder: "/mnt/shared" },
      { key: "for_principal", label: "For user or %group", placeholder: "%Engineers" },
      { key: "options", label: "Options" },
    ],
    blank: { name: "", unc: "", mount_point: "", for_principal: "", options: "" },
  },
  {
    key: "sudo_rules",
    title: "Sudo rules",
    note: "Users and commands are comma separated. Validated with visudo before install.",
    fields: [
      { key: "name", label: "Name", width: "140px" },
      { key: "users", label: "Users and %groups", placeholder: "%Helpdesk" },
      { key: "commands", label: "Commands", placeholder: "/usr/bin/systemctl" },
      { key: "run_as", label: "Run as", width: "110px" },
      { key: "nopasswd", label: "NOPASSWD", kind: "checkbox", width: "110px" },
    ],
    blank: { name: "", users: [], commands: [], run_as: "ALL", nopasswd: false },
  },
  {
    key: "logon_rights",
    title: "Logon rights",
    note: "Deny overrides allow. Local administrators are never locked out.",
    fields: [
      { key: "principal", label: "User or %group", placeholder: "%Engineers" },
      {
        key: "service",
        label: "Service",
        kind: "select",
        options: ["all", "local", "ssh", "rdp"],
        width: "120px",
      },
      {
        key: "access",
        label: "Access",
        kind: "select",
        options: ["allow", "deny"],
        width: "110px",
      },
    ],
    blank: { principal: "", service: "all", access: "allow" },
  },
  {
    key: "firewall",
    title: "Firewall rules",
    fields: [
      { key: "name", label: "Name", width: "140px" },
      { key: "action", label: "Action", kind: "select", options: ["allow", "deny"], width: "110px" },
      { key: "direction", label: "Direction", kind: "select", options: ["in", "out"], width: "110px" },
      {
        key: "protocol",
        label: "Protocol",
        kind: "select",
        options: ["tcp", "udp", "icmp", "any"],
        width: "110px",
      },
      { key: "port", label: "Port", kind: "number", width: "100px" },
      { key: "source", label: "Source", placeholder: "10.0.0.0/8" },
    ],
    blank: { name: "", action: "allow", direction: "in", protocol: "tcp", port: null, source: "any" },
  },
];

// Fields the API models as a list but an operator types as a line.
const LIST_FIELDS = new Set(["users", "commands"]);

function toInput(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

function fromInput(field: FieldSpec, raw: string): unknown {
  if (LIST_FIELDS.has(field.key)) {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (field.kind === "number") return raw === "" ? null : Number(raw);
  return raw;
}

export function SettingsEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  function rows(category: CategorySpec): Record<string, unknown>[] {
    return (settings[category.key] as Record<string, unknown>[] | undefined) ?? [];
  }

  function update(category: CategorySpec, next: Record<string, unknown>[]) {
    onChange({ ...settings, [category.key]: next });
  }

  return (
    <div className="settings-editor">
      {CATEGORIES.map((category) => {
        const current = rows(category);
        return (
          <section key={String(category.key)}>
            <header>
              <h3>{category.title}</h3>
              <button
                type="button"
                className="ghost"
                onClick={() => update(category, [...current, { ...category.blank }])}
              >
                <Plus size={14} aria-hidden="true" />
                Add
              </button>
            </header>
            {category.note && <p className="muted">{category.note}</p>}

            {current.length > 0 && (
              <table className="data compact">
                <thead>
                  <tr>
                    {category.fields.map((field) => (
                      <th key={field.key} style={field.width ? { width: field.width } : undefined}>
                        {field.label}
                      </th>
                    ))}
                    <th style={{ width: "44px" }}>
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {current.map((row, index) => (
                    <tr key={index}>
                      {category.fields.map((field) => (
                        <td key={field.key}>
                          <Cell
                            field={field}
                            value={row[field.key]}
                            onChange={(value) => {
                              const next = [...current];
                              next[index] = { ...row, [field.key]: value };
                              update(category, next);
                            }}
                          />
                        </td>
                      ))}
                      <td>
                        <button
                          type="button"
                          className="icon"
                          aria-label={`Remove ${category.title} entry ${index + 1}`}
                          onClick={() => update(category, current.filter((_, i) => i !== index))}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      <section>
        <header>
          <h3>Desktop background</h3>
        </header>
        <div className="inline-fields">
          <label className="field">
            <span>Image URI</span>
            <input
              value={settings.wallpaper?.uri ?? ""}
              placeholder="file:///usr/share/backgrounds/corp.png"
              onChange={(e) =>
                onChange({
                  ...settings,
                  wallpaper: e.target.value
                    ? {
                        uri: e.target.value,
                        picture_options: settings.wallpaper?.picture_options ?? "zoom",
                      }
                    : undefined,
                })
              }
            />
          </label>
          <label className="field">
            <span>Fit</span>
            <select
              value={settings.wallpaper?.picture_options ?? "zoom"}
              onChange={(e) =>
                onChange({
                  ...settings,
                  wallpaper: settings.wallpaper
                    ? { ...settings.wallpaper, picture_options: e.target.value }
                    : undefined,
                })
              }
            >
              {["zoom", "scaled", "stretched", "centered", "wallpaper", "spanned", "none"].map(
                (option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ),
              )}
            </select>
          </label>
        </div>
      </section>

      <section>
        <header>
          <h3>Browser policy</h3>
        </header>
        <p className="muted">
          Chromium and Firefox managed-policy documents, written to each vendor&rsquo;s native
          location. Vendor ADMX templates render as forms once imported.
        </p>
        <JsonField
          label="Chromium"
          value={settings.browser?.chromium}
          onChange={(value) =>
            onChange({
              ...settings,
              browser: { chromium: value, firefox: settings.browser?.firefox ?? {} },
            })
          }
        />
        <JsonField
          label="Firefox"
          value={settings.browser?.firefox}
          onChange={(value) =>
            onChange({
              ...settings,
              browser: { chromium: settings.browser?.chromium ?? {}, firefox: value },
            })
          }
        />
      </section>
    </div>
  );
}

function Cell({
  field,
  value,
  onChange,
}: {
  field: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.kind === "checkbox") {
    return (
      <input
        type="checkbox"
        aria-label={field.label}
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.kind === "select") {
    return (
      <select
        aria-label={field.label}
        value={toInput(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === "textarea") {
    return (
      <textarea
        aria-label={field.label}
        rows={3}
        value={toInput(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      aria-label={field.label}
      type={field.kind === "number" ? "number" : "text"}
      placeholder={field.placeholder}
      value={toInput(value)}
      onChange={(e) => onChange(fromInput(field, e.target.value))}
    />
  );
}

function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Record<string, unknown> | undefined;
  onChange: (value: Record<string, unknown>) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        rows={5}
        className="mono"
        defaultValue={JSON.stringify(value ?? {}, null, 2)}
        onBlur={(e) => {
          try {
            onChange(JSON.parse(e.target.value || "{}"));
          } catch {
            /* invalid JSON is left for the operator to fix; nothing is sent */
          }
        }}
      />
    </label>
  );
}
