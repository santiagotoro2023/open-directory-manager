import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { AdmxSelection, PolicySettings } from "../api";
import { AdmxEditor } from "./AdmxEditor";
import { Split } from "./Split";

type FieldKind = "text" | "number" | "textarea" | "select" | "checkbox";

interface FieldSpec {
  key: string;
  label: string;
  kind?: FieldKind;
  options?: string[];
  placeholder?: string;
  width?: string;
}

type Half = "Computer" | "User";

interface CategorySpec {
  key: keyof PolicySettings;
  title: string;
  // Which half of the policy the setting is enforced in, as the Group Policy
  // Management Editor splits them.
  half: Half;
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
    half: "Computer",
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
    half: "Computer",
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
    half: "Computer",
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
    half: "Computer",
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
    half: "User",
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
    note: "Users and commands are comma separated.",
    half: "Computer",
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
    key: "hbac_rules",
    title: "HBAC rules",
    note: "Who may open a session on a machine, and how.",
    half: "Computer",
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
    key: "packages",
    title: "Software deployment",
    half: "Computer",
    note: "Packages the machine should have, keep current, or not have.",
    fields: [
      { key: "name", label: "Package", placeholder: "cifs-utils" },
      {
        key: "state",
        label: "State",
        kind: "select",
        options: ["present", "latest", "absent"],
        width: "130px",
      },
    ],
    blank: { name: "", state: "present" },
  },
  {
    key: "firewall",
    title: "Firewall rules",
    half: "Computer",
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

// Categories with no repeating rows; each renders its own editor.
const SPECIAL = [
  { key: "wallpaper", title: "Desktop background", half: "User" as Half },
  { key: "browser", title: "Browser policy", half: "Computer" as Half },
  { key: "admx", title: "Administrative templates", half: "Computer" as Half },
] as const;

type Selected = string;

function countOf(settings: PolicySettings, key: string): number {
  if (key === "wallpaper") return settings.wallpaper?.uri ? 1 : 0;
  if (key === "browser") {
    const browser = settings.browser;
    if (!browser) return 0;
    return (
      Object.keys(browser.chromium ?? {}).length + Object.keys(browser.firefox ?? {}).length
    );
  }
  const value = settings[key as keyof PolicySettings];
  return Array.isArray(value) ? value.length : 0;
}

export function SettingsEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  const [selected, setSelected] = useState<Selected>(String(CATEGORIES[0].key));

  const entries = [
    ...CATEGORIES.map((category) => ({
      key: String(category.key),
      title: category.title,
      half: category.half,
    })),
    ...SPECIAL.map((special) => ({
      key: special.key,
      title: special.title,
      half: special.half,
    })),
  ];

  const tree = (
    <ul className="category-list">
      {(["Computer", "User"] as Half[]).map((half) => (
        <li key={half}>
          <p className="category-group">{half}</p>
          <ul>
            {entries
              .filter((entry) => entry.half === half)
              .map((entry) => {
                const count = countOf(settings, entry.key);
                return (
                  <li key={entry.key}>
                    <button
                      type="button"
                      className={selected === entry.key ? "active" : ""}
                      aria-current={selected === entry.key ? "true" : undefined}
                      onClick={() => setSelected(entry.key)}
                    >
                      <span className="truncate">{entry.title}</span>
                      {count > 0 && (
                        <span className="count" aria-label={`${count} configured`}>
                          {count}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
          </ul>
        </li>
      ))}
    </ul>
  );

  const category = CATEGORIES.find((entry) => String(entry.key) === selected);

  return (
    <div className="settings-editor">
      <Split id="policy-categories" label="Resize the category list" initial={230} side={tree}>
        <div className="category-editor">
          {category && (
            <RowsEditor category={category} settings={settings} onChange={onChange} />
          )}
          {selected === "wallpaper" && (
            <WallpaperEditor settings={settings} onChange={onChange} />
          )}
          {selected === "browser" && <BrowserEditor settings={settings} onChange={onChange} />}
          {selected === "admx" && (
            <>
              <header>
                <h3>Administrative templates</h3>
              </header>
              <AdmxEditor
                selections={settings.admx ?? []}
                onChange={(admx: AdmxSelection[]) => onChange({ ...settings, admx })}
              />
            </>
          )}
        </div>
      </Split>
    </div>
  );
}

function RowsEditor({
  category,
  settings,
  onChange,
}: {
  category: CategorySpec;
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  const current = (settings[category.key] as Record<string, unknown>[] | undefined) ?? [];

  function update(next: Record<string, unknown>[]) {
    onChange({ ...settings, [category.key]: next });
  }

  return (
    <>
      <header>
        <h3>{category.title}</h3>
        <span className="spacer" />
        <button
          type="button"
          className="primary"
          onClick={() => update([...current, { ...category.blank }])}
        >
          <Plus size={15} aria-hidden="true" />
          Add
        </button>
      </header>
      {category.note && <p className="muted">{category.note}</p>}

      {current.length === 0 ? (
        <p className="empty">Not configured.</p>
      ) : (
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
                        update(next);
                      }}
                    />
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    className="icon"
                    aria-label={`Remove ${category.title} entry ${index + 1}`}
                    onClick={() => update(current.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function WallpaperEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  return (
    <>
      <header>
        <h3>Desktop background</h3>
      </header>
      <div className="inline-fields">
        <label className="field">
          <span>Image location</span>
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
    </>
  );
}

function BrowserEditor({
  settings,
  onChange,
}: {
  settings: PolicySettings;
  onChange: (next: PolicySettings) => void;
}) {
  return (
    <>
      <header>
        <h3>Browser policy</h3>
      </header>
      <p className="muted">
        Managed-policy documents, written to each browser&rsquo;s own policy directory.
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
    </>
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
